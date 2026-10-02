"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { chunkKnowledgeBase } from "@relaypay/shared/kb";
import { ConfirmButton } from "@/components/ConfirmButton";
import { When } from "@/components/When";

export type HistoryEntry = {
  version: number;
  markdown: string;
  keywords: Record<string, string>;
  chunk_count: number;
  recall: number | null;
  forced: boolean;
  note: string | null;
  by: string;
  published_at: string;
};

type CheckResult = {
  published: boolean;
  version: number | null;
  passed: boolean;
  chunks: number;
  added: string[];
  removed: string[];
  changed: string[];
  recall: number | null;
  recall_before: number | null;
  answerable: number;
  hits: number;
  misses: { q: string; expect: string[]; got: string[] }[];
  leaks: { q: string; got: string[] }[];
  /** Gold questions that find their answer today and wouldn't after this change. */
  regressed: { q: string; expect: string[]; got: string[] }[];
  new_leaks: { q: string; got: string[] }[];
  orphanKeywords: string[];
  orphanGold: string[];
  minRecall: number;
};

const pct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
const stringify = (k: Record<string, string>) => JSON.stringify(k, null, 2);

/**
 * Edit the knowledge base, check the change on the real search, publish it.
 *
 * The flow is check-then-publish: a check runs the gold questions against the
 * edited chunks in a transaction that is rolled back, so the admin sees what
 * publishing would do before the agent sees any of it. Any edit after a check
 * makes it stale, and Publish waits for a fresh one.
 */
export function KnowledgeEditor({
  initialMarkdown,
  initialKeywords,
  history,
}: {
  initialMarkdown: string;
  initialKeywords: Record<string, string>;
  history: HistoryEntry[];
}) {
  const router = useRouter();
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [keywordsText, setKeywordsText] = useState(stringify(initialKeywords));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"check" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ for: string; data: CheckResult } | null>(null);
  const [published, setPublished] = useState<string | null>(null);

  // Re-sync after a publish refreshes the server data.
  useEffect(() => {
    setMarkdown(initialMarkdown);
    setKeywordsText(stringify(initialKeywords));
  }, [initialMarkdown, initialKeywords]);

  const keywords = useMemo(() => {
    try {
      const v = JSON.parse(keywordsText);
      if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "Keywords must be a JSON object: { \"chunk-id\": \"words a caller might say\" }" };
      return { value: v as Record<string, string> };
    } catch (e) {
      return { error: `Keywords are not valid JSON: ${(e as Error).message}` };
    }
  }, [keywordsText]);

  const outline = useMemo(() => {
    try {
      return { chunks: chunkKnowledgeBase(markdown, keywords.value ?? {}) };
    } catch (e) {
      return { error: (e as Error).message, chunks: [] };
    }
  }, [markdown, keywords.value]);

  const fingerprint = `${markdown}\u0000${keywordsText}`;
  const dirty = markdown !== initialMarkdown || keywordsText !== stringify(initialKeywords);
  const fresh = result?.for === fingerprint ? result.data : null;
  const stale = result !== null && !fresh;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function send(mode: "check" | "publish", force = false) {
    if (!keywords.value) return;
    setBusy(mode);
    setError(null);
    setPublished(null);
    const res = await fetch("/api/admin/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, markdown, keywords: keywords.value, note: note.trim() || undefined, force }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(data.error ?? `Failed (${res.status})`);
      return;
    }
    const r = data as CheckResult;
    setResult({ for: fingerprint, data: r });
    if (mode === "publish" && r.published) {
      setPublished(`Version ${r.version} is live: ${r.chunks} chunks re-ingested. The agent searches the new text from its next question.`);
      setNote("");
      router.refresh();
    } else if (mode === "publish") {
      setError("Not published: the check failed. Nothing changed.");
    }
  }

  function load(entry: HistoryEntry) {
    setMarkdown(entry.markdown);
    setKeywordsText(stringify(entry.keywords));
    setNote(`Restore version ${entry.version}`);
    setResult(null);
    setError(null);
    setPublished(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const canCheck = !busy && !keywords.error && !outline.error && outline.chunks.length > 0;

  return (
    <div className="kb-layout">
      <div className="kb-main">
        <section className="panel">
          <div className="panel-head">
            <h2>Document</h2>
            <span className="muted">
              {outline.chunks.length} chunks · {markdown.length.toLocaleString()} characters{dirty ? " · unsaved changes" : ""}
            </span>
          </div>
          <label htmlFor="kb-markdown" className="sr-only">
            Knowledge base (Markdown)
          </label>
          <textarea
            id="kb-markdown"
            className="field kb-text"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            spellCheck
            disabled={busy !== null}
          />
          <p className="hint">
            Markdown. Each <code>##</code> heading is a section and each <code>###</code> under it becomes one searchable chunk; its id comes from
            the headings, so renaming a heading gives it a new id. Write only approved facts: the agent answers from this text and nothing else.
          </p>

          <details className="kb-keywords">
            <summary>Search keywords (advanced)</summary>
            <p className="hint">
              Words a caller might say that the text doesn&apos;t, per chunk id. Synonyms only: a keyword must never add a fact.
            </p>
            <textarea
              className="field kb-text small"
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              spellCheck={false}
              aria-label="Search keywords as JSON"
              disabled={busy !== null}
            />
          </details>
          {keywords.error ? <p className="notice bad">{keywords.error}</p> : null}
          {outline.error ? <p className="notice bad">{outline.error}</p> : null}
        </section>

        <section className="panel">
          <h2>Check and publish</h2>
          <label className="label" htmlFor="kb-note">
            What changed
          </label>
          <input
            id="kb-note"
            className="field"
            maxLength={500}
            placeholder="e.g. Updated the GBP payout cut-off to 3pm"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy !== null}
          />
          <div className="kb-actions">
            <button type="button" className="btn secondary" disabled={!canCheck} onClick={() => void send("check")}>
              {busy === "check" ? "Checking…" : "Check changes"}
            </button>
            {fresh?.passed ? (
              <ConfirmButton
                label="Publish and re-ingest"
                confirmLabel="Publish"
                variant="primary"
                question={`Publish ${fresh.chunks} chunks to the live agent?`}
                detail="Calls in progress use the new text from their next question. Earlier versions stay in the history."
                busy={busy === "publish"}
                busyLabel="Publishing…"
                disabled={!canCheck}
                onConfirm={() => send("publish")}
              />
            ) : fresh && !fresh.passed ? (
              <ConfirmButton
                label="Publish anyway"
                confirmLabel="Publish anyway"
                tone="danger"
                question="Publish although retrieval got worse?"
                detail="Callers asking the questions listed above may get no answer, or the wrong section, and the agent will open a ticket instead. Fixing the text or keywords first is better."
                busy={busy === "publish"}
                busyLabel="Publishing…"
                disabled={!canCheck}
                onConfirm={() => send("publish", true)}
              />
            ) : (
              <button type="button" className="btn" disabled>
                Publish and re-ingest
              </button>
            )}
            {dirty ? (
              <ConfirmButton
                label="Discard changes"
                confirmLabel="Discard"
                question="Discard your edits?"
                detail="The editor goes back to the live version."
                tone="danger"
                disabled={busy !== null}
                onConfirm={() => {
                  setMarkdown(initialMarkdown);
                  setKeywordsText(stringify(initialKeywords));
                  setResult(null);
                  setError(null);
                }}
              />
            ) : null}
          </div>
          {!fresh && !error ? (
            <p className="hint">
              {stale ? "You've edited since the last check. Check again before publishing." : "Publishing needs a check of the current text first."}
            </p>
          ) : null}
          {error ? <p className="notice bad">{error}</p> : null}
          {published ? <p className="notice ok">{published}</p> : null}

          {result ? <CheckReport r={result.data} stale={stale} /> : null}
        </section>
      </div>

      <aside className="kb-side">
        <section className="panel">
          <h2>Outline</h2>
          {outline.chunks.length ? (
            <ol className="kb-outline">
              {outline.chunks.map((c, i) => (
                <li key={c.id}>
                  {i === 0 || outline.chunks[i - 1].section !== c.section ? <span className="kb-section">{c.section}</span> : null}
                  <span className="kb-chunk">
                    {c.title === c.section ? "Overview" : c.title}
                    <code>{c.id}</code>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty">No chunks yet.</p>
          )}
        </section>

        <section className="panel">
          <h2>History</h2>
          {history.length ? (
            <ul className="list">
              {history.map((h, i) => (
                <li key={h.version}>
                  <span className="list-main">
                    <strong>v{h.version}</strong>
                    {i === 0 ? <span className="pill done">live</span> : null}
                    {h.forced ? <span className="pill attention">published anyway</span> : null}
                    <span className="muted">
                      {" "}
                      · {h.by}, <When iso={h.published_at} mode="relative" /> · {h.chunk_count} chunks · recall {pct(h.recall)}
                    </span>
                    {h.note ? <span className="kb-note">{h.note}</span> : null}
                  </span>
                  {i > 0 ? (
                    <button type="button" className="btn small secondary" onClick={() => load(h)} disabled={busy !== null}>
                      Load
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Nothing published from here yet. The live text came from the repository.</p>
          )}
          {history.length > 1 ? <p className="hint">Load puts an old version in the editor. Check and publish it to restore it.</p> : null}
        </section>
      </aside>
    </div>
  );
}

function CheckReport({ r, stale }: { r: CheckResult; stale: boolean }) {
  const ids = (xs: string[]) => (xs.length ? xs.map((x) => <code key={x} className="chip">{x}</code>) : <span className="muted">none</span>);
  return (
    <div className={`kb-report ${stale ? "stale" : ""}`}>
      <p className={`notice ${r.passed ? "ok" : "bad"}`}>
        {r.published
          ? `Published as version ${r.version}.`
          : r.passed
            ? "Check passed: every question that finds its answer today still does."
            : r.regressed.length
              ? `Check failed: ${r.regressed.length} question${r.regressed.length > 1 ? "s" : ""} that find their answer today would stop finding it.`
              : r.new_leaks.length
                ? "Check failed: off-topic questions would start matching approved text."
                : `Check failed: recall is below ${pct(r.minRecall)}.`}{" "}
        Recall@3 {pct(r.recall)} ({r.hits}/{r.answerable} gold questions), live now {pct(r.recall_before)}.
        {stale ? " (Measured before your latest edits.)" : ""}
      </p>
      <dl className="facts">
        <dt>Chunks</dt>
        <dd>{r.chunks}</dd>
        <dt>Added</dt>
        <dd>{ids(r.added)}</dd>
        <dt>Changed</dt>
        <dd>{ids(r.changed)}</dd>
        <dt>Removed</dt>
        <dd>{ids(r.removed)}</dd>
      </dl>
      {r.regressed.length ? (
        <>
          <h3 className="kb-h3">Questions this change would break</h3>
          <MissList items={r.regressed} />
        </>
      ) : null}
      {r.misses.length > r.regressed.length ? (
        <>
          <h3 className="kb-h3">Already missing before this change</h3>
          <MissList items={r.misses.filter((m) => !r.regressed.some((x) => x.q === m.q))} />
        </>
      ) : null}
      {r.new_leaks.length ? (
        <>
          <h3 className="kb-h3">Off-topic questions that would start matching</h3>
          <ul className="kb-misses">
            {r.new_leaks.map((m) => (
              <li key={m.q}>
                <q>{m.q}</q> <span className="muted">matched {m.got.join(", ")}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {r.orphanGold.length ? (
        <p className="hint">Gold questions expect chunks that no longer exist: {r.orphanGold.join(", ")}. A renamed heading changes its id.</p>
      ) : null}
      {r.orphanKeywords.length ? (
        <p className="hint">Keywords dropped because their chunk is gone: {r.orphanKeywords.join(", ")}.</p>
      ) : null}
    </div>
  );
}

function MissList({ items }: { items: { q: string; expect: string[]; got: string[] }[] }) {
  return (
    <ul className="kb-misses">
      {items.map((m) => (
        <li key={m.q}>
          <q>{m.q}</q>
          <span className="muted">
            {" "}
            expected {m.expect.join(" or ")}, found {m.got.length ? m.got.join(", ") : "nothing"}
          </span>
        </li>
      ))}
    </ul>
  );
}
