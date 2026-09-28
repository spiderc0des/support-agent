/**
 * One live Agent SDK session per call.
 *
 * A call is a single long-running `query()` in streaming-input mode: each
 * caller utterance is pushed into its input queue, and the session's output
 * is split back into turns at each `result` message. Keeping the Claude Code
 * process alive for the whole call avoids a process spawn per turn (seconds
 * of dead air), keeps the conversation inside the SDK, and makes prompt
 * caching incremental.
 *
 * The agent's only tools are the RelayPay MCP server's. Built-ins are removed
 * (`tools: []`), nothing is loaded from settings files, and a deny-by-default
 * permission gate records any attempt to use something else.
 */
import { query, type PermissionResult, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Channel } from "@relaypay/shared/enums";
import { buildSystemPrompt } from "./system-prompt.ts";
import { SpeechFilter, type ControlTag } from "./speech-filter.ts";

export const MCP_SERVER_NAME = "relaypay";
export const RELAYPAY_TOOLS = [
  "search_knowledge_base",
  "lookup_customer",
  "lookup_transaction",
  "lookup_payout",
  "create_support_ticket",
  "create_escalation",
  "log_conversation_event",
] as const;
const ALLOWED = RELAYPAY_TOOLS.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

export const DEFAULT_MODEL = "claude-haiku-4-5";

export type SessionConfig = {
  conversationId: string;
  channel: Channel;
  model?: string;
  mcpUrl: string;
  mcpToken: string;
  /** Hard cap on model spend for the whole call. */
  budgetUsd?: number;
  /** Tool calls allowed in one turn before it is cut off. */
  maxToolCallsPerTurn?: number;
  /** Called when the agent reaches for a tool outside its surface. */
  onDeniedTool?: (toolName: string) => void;
  /** Tests substitute a fake Agent SDK here; production uses the real `query`. */
  queryFn?: typeof query;
  /** Tests pass a stub prompt so they don't depend on the skill files. */
  systemPrompt?: string;
  interruptGraceMs?: number;
};

export type TurnResult = {
  text: string;
  tag: ControlTag | null;
  malformedTag: boolean;
  toolsUsed: string[];
  redactions: string[];
  status: "ok" | "interrupted" | "error" | "timeout";
  errorMessage: string | null;
  firstTokenMs: number | null;
  latencyMs: number;
  costUsd: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

type PendingTurn = {
  filter: SpeechFilter;
  startedAt: number;
  firstTokenAt: number | null;
  toolsUsed: string[];
  push: (text: string) => void;
  finish: (result: TurnResult) => void;
  interrupted: boolean;
  timedOut: boolean;
  errorMessage: string | null;
  /** Resolves once the turn has been settled, by its result or by force. */
  done: Promise<void>;
};

/** How long an interrupted turn may take to produce its result before it is settled by force. */
const INTERRUPT_GRACE_MS = 3_000;

/** Minimal push-based async queue: one side writes, one side iterates. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(item: T) {
    this.items.push(item);
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

export class SupportSession {
  readonly conversationId: string;
  readonly model: string;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private q: Query | null = null;
  private ready: Promise<void> | null = null;
  private current: PendingTurn | null = null;
  private lastTotalCost = 0;
  private closed = false;
  lastActivity = Date.now();
  spawnMs: number | null = null;
  fatalError: string | null = null;

  constructor(private readonly config: SessionConfig) {
    this.conversationId = config.conversationId;
    this.model = config.model ?? process.env.AGENT_MODEL ?? DEFAULT_MODEL;
  }

  get isBusy() {
    return this.current !== null;
  }

  get isClosed() {
    return this.closed;
  }

  /** Turns sent to this session so far. The first one carries the per-call context. */
  turnsSent = 0;

  /**
   * Spawn the agent process. Safe to call more than once.
   *
   * The returned promise resolves on the SDK's `init` message, which the SDK
   * only sends AFTER it receives the first user message. So nothing may wait
   * on this before sending that message: sendTurn() pushes first and lets
   * init arrive during the turn. (Awaiting it first deadlocked every call.)
   * Calling start() early still helps: the CLI process spawns and connects
   * to the MCP server while the greeting plays.
   */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    const t0 = Date.now();
    const maxTools = this.config.maxToolCallsPerTurn ?? 6;

    // allowedTools already admits the RelayPay tools without asking; this
    // only runs for anything else, which is refused and reported.
    const canUseTool = async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
      if (ALLOWED.includes(toolName)) return { behavior: "allow", updatedInput: input };
      this.config.onDeniedTool?.(toolName);
      return { behavior: "deny", message: `'${toolName}' is not available. Only the RelayPay support tools are.` };
    };

    this.q = (this.config.queryFn ?? query)({
      prompt: this.input,
      options: {
        model: this.model,
        systemPrompt: this.config.systemPrompt ?? buildSystemPrompt(),
        // No built-in tools, no project or user settings, no skills tool:
        // the RelayPay MCP server is the agent's entire surface.
        tools: [],
        settingSources: [],
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: "http",
            url: this.config.mcpUrl,
            headers: {
              Authorization: `Bearer ${this.config.mcpToken}`,
              "X-Conversation-Id": this.config.conversationId,
            },
            timeout: 10_000,
          },
        },
        allowedTools: ALLOWED,
        canUseTool,
        includePartialMessages: true,
        persistSession: false,
        maxBudgetUsd: this.config.budgetUsd ?? Number(process.env.CALL_BUDGET_USD ?? 0.5),
        // Latency over depth: voice turns are short and rule-guided. Without
        // this the SDK runs Haiku with extended thinking, which measured
        // 2-3 s of silence per model request. Sonnet 5 keeps adaptive
        // thinking at low effort.
        ...(this.model.startsWith("claude-haiku")
          ? { thinking: { type: "disabled" as const } }
          : { effort: "low" as const }),
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } as Record<string, string>,
      },
    });

    this.ready = new Promise<void>((resolve, reject) => {
      const onInit = () => {
        this.spawnMs = Date.now() - t0;
        resolve();
      };
      void this.consume(onInit, maxTools).catch((err) => {
        this.fatalError = err instanceof Error ? err.message : String(err);
        reject(err);
        this.failCurrent(this.fatalError);
        this.closed = true;
      });
    });
    return this.ready;
  }

  /**
   * Send one caller utterance. `onText` receives speakable text as soon as a
   * sentence is complete; the promise resolves when the turn ends.
   */
  async sendTurn(userText: string, onText: (text: string) => void, opts: { timeoutMs?: number; callerEmails?: string[] } = {}): Promise<TurnResult> {
    if (this.closed) throw new Error(this.fatalError ?? "Session is closed");
    // Not awaited: init only arrives after this turn's message is sent. A
    // failure to start settles the turn through consume()'s error path.
    this.start().catch(() => {});
    if (this.current) throw new Error("A turn is already in progress; interrupt it first");
    this.lastActivity = Date.now();

    // Under Vapi's own custom-LLM cutoff (about 20 s, observed): the caller
    // must hear our fallback reply before Vapi abandons the call.
    const timeoutMs = opts.timeoutMs ?? 15_000;
    return new Promise<TurnResult>((resolve) => {
      let markDone: () => void = () => {};
      const turn: PendingTurn = {
        filter: new SpeechFilter(opts.callerEmails ?? []),
        startedAt: Date.now(),
        firstTokenAt: null,
        toolsUsed: [],
        push: (text) => {
          if (!text) return;
          if (turn.firstTokenAt === null) turn.firstTokenAt = Date.now();
          onText(text);
        },
        finish: () => {},
        interrupted: false,
        timedOut: false,
        errorMessage: null,
        done: new Promise<void>((r) => (markDone = r)),
      };
      const timer = setTimeout(() => {
        turn.timedOut = true;
        void this.interrupt();
      }, timeoutMs);
      let settled = false;
      turn.finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
        markDone();
      };
      this.current = turn;
      this.turnsSent++;
      this.input.push({ type: "user", message: { role: "user", content: userText }, parent_tool_use_id: null });
    });
  }

  /**
   * Stop the turn in progress (caller barged in, or it ran too long), and
   * resolve once it is settled. If the agent does not produce the turn's
   * result within a short grace period, the turn is settled by force and its
   * late result, if one ever comes, is discarded rather than mistaken for
   * the next turn's.
   */
  async interrupt(): Promise<void> {
    const turn = this.current;
    if (!turn || !this.q) return;
    turn.interrupted = true;
    try {
      await this.q.interrupt();
    } catch {
      // Already finished; the result handler settles the turn.
    }
    const grace = this.config.interruptGraceMs ?? INTERRUPT_GRACE_MS;
    const graceOver = new Promise<"grace">((r) => setTimeout(() => r("grace"), grace));
    if ((await Promise.race([turn.done.then(() => "done" as const), graceOver])) === "grace" && this.current === turn) {
      this.current = null;
      this.orphanedResults++;
      this.orphanExpiry = Date.now() + 10_000;
      turn.push(turn.filter.flush());
      turn.finish(this.settle(turn, turn.timedOut ? "timeout" : "interrupted", turn.errorMessage, 0, null));
    }
  }

  /**
   * Results still owed by turns that were settled by force. Expires quickly:
   * if a forced turn never produces its result, the counter must not swallow
   * a later turn's.
   */
  private orphanedResults = 0;
  private orphanExpiry = 0;

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    try {
      this.q?.close();
    } catch {
      // ignore
    }
    this.failCurrent("Session closed");
  }

  private failCurrent(message: string) {
    const turn = this.current;
    if (!turn) return;
    this.current = null;
    turn.push(turn.filter.flush());
    turn.finish(this.settle(turn, "error", message, 0, null));
  }

  private settle(
    turn: PendingTurn,
    status: TurnResult["status"],
    errorMessage: string | null,
    costUsd: number,
    usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null,
  ): TurnResult {
    return {
      text: turn.filter.spoken.trim(),
      tag: turn.filter.tag,
      malformedTag: turn.filter.malformedTag,
      toolsUsed: turn.toolsUsed,
      redactions: turn.filter.redactions,
      status,
      errorMessage,
      firstTokenMs: turn.firstTokenAt ? turn.firstTokenAt - turn.startedAt : null,
      latencyMs: Date.now() - turn.startedAt,
      costUsd,
      usage: {
        input: usage?.input_tokens ?? 0,
        output: usage?.output_tokens ?? 0,
        cacheRead: usage?.cache_read_input_tokens ?? 0,
        cacheWrite: usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }

  private async consume(onInit: () => void, maxTools: number) {
    for await (const m of this.q!) {
      if (m.type === "system" && m.subtype === "init") {
        onInit();
        continue;
      }
      // A result owed by a turn that was already settled by force (see
      // interrupt()), or one with no turn waiting: keep the cost baseline
      // right, and don't hand it to whichever turn is current now.
      if (m.type === "result" && (!this.current || (this.orphanedResults > 0 && Date.now() < this.orphanExpiry))) {
        if (this.current) this.orphanedResults--;
        this.lastTotalCost = m.total_cost_usd ?? this.lastTotalCost;
        continue;
      }
      const turn = this.current;
      if (!turn) continue;

      if (m.type === "stream_event" && m.parent_tool_use_id === null) {
        const ev = m.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          turn.push(turn.filter.push(ev.delta.text));
        } else if (ev.type === "content_block_stop") {
          // A text block ends before each tool call: release the filler
          // sentence now, so it is heard while the tool runs.
          turn.push(turn.filter.boundary());
        }
        continue;
      }

      if (m.type === "assistant" && m.parent_tool_use_id === null) {
        for (const block of m.message.content) {
          if (block.type === "tool_use") {
            turn.toolsUsed.push(block.name.replace(`mcp__${MCP_SERVER_NAME}__`, ""));
            if (turn.toolsUsed.length > maxTools) {
              turn.errorMessage = `More than ${maxTools} tool calls in one turn`;
              void this.interrupt();
            }
          }
        }
        continue;
      }

      if (m.type === "result") {
        this.current = null;
        this.lastActivity = Date.now();
        // total_cost_usd is cumulative across the session's turns.
        const total = m.total_cost_usd ?? this.lastTotalCost;
        const costUsd = Math.max(0, Number((total - this.lastTotalCost).toFixed(6)));
        this.lastTotalCost = total;

        turn.push(turn.filter.flush());
        const status: TurnResult["status"] = turn.timedOut
          ? "timeout"
          : turn.errorMessage
            ? "error"
            : turn.interrupted
              ? "interrupted"
              : m.subtype === "success"
                ? "ok"
                : "error";
        const errorMessage =
          turn.errorMessage ??
          (m.subtype !== "success" && !turn.interrupted ? `Agent stopped: ${m.subtype}` : null);
        turn.finish(this.settle(turn, status, errorMessage, costUsd, m.usage));

        if (m.subtype === "error_max_budget_usd") {
          this.fatalError = "Call budget reached";
          this.close();
        }
      }
    }
    // The stream ended: the process exited.
    this.closed = true;
    this.failCurrent(this.fatalError ?? "Agent process ended");
  }
}
