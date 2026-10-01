"use client";

/**
 * The web voice call. Vapi's Web SDK owns the microphone, speech-to-text and
 * speech output; this component starts and stops the call and shows where it
 * stands.
 *
 * Deliberately not a chat window (brand direction): a status line, a level
 * bar, and one caption per speaker. Each caption holds that speaker's whole
 * current turn (see lib/captions.ts). A soft ring plays while the call
 * connects and stops when the agent starts speaking.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Vapi from "@vapi-ai/web";
import { ConfirmButton } from "@/components/ConfirmButton";
import { captionsReducer, fromVapiMessage, initialCaptions, type CaptionLine } from "@/lib/captions";
import { startRingback, type Ringback } from "@/lib/ringback";
import { END_CALL_PHRASE } from "@/agent/closing";

type CallState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ended" | "error";

const LABEL: Record<CallState, string> = {
  idle: "Support is available. Start a call to begin.",
  connecting: "Calling RelayPay support…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
  error: "Something went wrong",
};

/** After the call connects, the greeting normally starts within a second; stop ringing regardless after this. */
const RING_AFTER_CONNECT_MS = 4000;

/**
 * When the agent says the end-call phrase, Vapi hangs up on its side
 * (endedReason assistant-said-end-call-phrase), but the Web SDK does not
 * always tell the page. So once the goodbye has finished playing, the page
 * closes the call itself. The longer wait covers a goodbye whose playback
 * end is never reported.
 */
const CLOSE_AFTER_GOODBYE_MS = 1500;
const CLOSE_GOODBYE_FALLBACK_MS = 10_000;
const PHRASE = END_CALL_PHRASE.toLowerCase().replace(/\.$/, "");

type ResetAction = { reset: true };

export function VoiceCall({ publicKey, assistantId }: { publicKey: string; assistantId: string }) {
  const vapiRef = useRef<Vapi | null>(null);
  const ringRef = useRef<Ringback | null>(null);
  const [state, setState] = useState<CallState>("idle");
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [captions, dispatch] = useReducer(
    (s: typeof initialCaptions, a: Parameters<typeof captionsReducer>[1] | ResetAction) => ("reset" in a ? initialCaptions : captionsReducer(s, a)),
    initialCaptions,
  );
  const [error, setError] = useState<string | null>(null);

  const configured = Boolean(publicKey && assistantId);

  const stopRing = useCallback(() => {
    ringRef.current?.stop();
    ringRef.current = null;
  }, []);

  useEffect(() => {
    if (!configured) return;
    const vapi = new Vapi(publicKey);
    vapiRef.current = vapi;
    let ringTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let saidGoodbye = false;
    let ended = false;
    let speaking = false;

    // Idempotent: Vapi's own call-end, a status message, or our backstop may all arrive.
    const finish = () => {
      if (ended) return;
      ended = true;
      clearTimeout(closeTimer);
      clearTimeout(fallbackTimer);
      stopRing();
      setState((s) => (s === "error" ? s : "ended"));
      setLevel(0);
      setMuted(false);
      void vapi.stop();
    };
    const closeSoon = (ms: number) => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(finish, ms);
    };

    vapi.on("call-start", () => {
      ended = false;
      saidGoodbye = false;
      setState("listening");
      ringTimer = setTimeout(stopRing, RING_AFTER_CONNECT_MS);
    });
    vapi.on("call-end", finish);
    vapi.on("speech-start", () => {
      speaking = true;
      stopRing();
      setState("speaking");
    });
    vapi.on("speech-end", () => {
      speaking = false;
      if (saidGoodbye) closeSoon(CLOSE_AFTER_GOODBYE_MS);
      else setState("listening");
    });
    vapi.on("volume-level", (v: number) => setLevel(v));
    vapi.on("message", (m: Parameters<typeof fromVapiMessage>[0] & { status?: string }) => {
      if (m.type === "status-update" && m.status === "ended") return finish();
      const ev = fromVapiMessage(m);
      if (!ev) return;
      dispatch(ev);
      if (ev.role === "user" && ev.final) setState("thinking");
      if (ev.role === "agent" && ev.final && ev.text.toLowerCase().includes(PHRASE) && !saidGoodbye) {
        saidGoodbye = true;
        fallbackTimer = setTimeout(finish, CLOSE_GOODBYE_FALLBACK_MS);
        // Transcript can land after the goodbye has already finished playing.
        if (!speaking) closeSoon(CLOSE_AFTER_GOODBYE_MS);
      }
    });
    vapi.on("error", (e: unknown) => {
      stopRing();
      // When Vapi hangs up (after the agent's goodbye, or a long silence),
      // the calling layer reports it as an "ejection" error. That is a
      // normal end of call, not a failure.
      if (isNormalHangUp(e)) return finish();
      console.error("[vapi]", e);
      setError("The call could not continue. Please try again.");
      setState("error");
    });

    return () => {
      clearTimeout(ringTimer);
      clearTimeout(closeTimer);
      clearTimeout(fallbackTimer);
      stopRing();
      void vapi.stop();
      vapi.removeAllListeners();
      vapiRef.current = null;
    };
  }, [configured, publicKey, stopRing]);

  const start = useCallback(async () => {
    const vapi = vapiRef.current;
    if (!vapi) return;
    setError(null);
    dispatch({ reset: true });
    setState("connecting");
    // Started inside the click that confirmed the call: browsers only let
    // audio begin from a user gesture.
    stopRing();
    ringRef.current = startRingback();
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      stopRing();
      setError("Microphone access is blocked. Allow it in your browser settings to talk to support.");
      setState("error");
      return;
    }
    try {
      await vapi.start(assistantId);
    } catch (e) {
      console.error("[vapi] start failed", e);
      stopRing();
      setError("We couldn't start the call. Please try again in a moment.");
      setState("error");
    }
  }, [assistantId, stopRing]);

  const stop = useCallback(() => {
    stopRing();
    void vapiRef.current?.stop();
  }, [stopRing]);

  const toggleMute = useCallback(() => {
    const vapi = vapiRef.current;
    if (!vapi) return;
    vapi.setMuted(!vapi.isMuted());
    setMuted(vapi.isMuted());
  }, []);

  if (!configured) {
    return <p className="error">Voice support is not configured yet (Vapi public key and assistant ID are missing).</p>;
  }

  const inCall = state === "listening" || state === "thinking" || state === "speaking";

  return (
    <div>
      <div className="status" role="status" aria-live="polite">
        <span className="dot" data-state={state === "error" ? "error" : state} />
        {LABEL[state]}
        {muted && inCall ? " (muted)" : ""}
      </div>

      <div className="level" aria-hidden="true">
        <span style={{ width: `${Math.round(Math.min(1, level * 1.5) * 100)}%` }} />
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="actions">
        {inCall || state === "connecting" ? (
          <>
            {/* Distinct keys: the Start and End confirmations render in the same
                place, and without them React reuses one instance, so the Start
                confirmation's open state reappeared as "End the call?" while
                the call was connecting. */}
            <ConfirmButton
              key="end-call"
              label="End call"
              confirmLabel="End call"
              question="End the call?"
              detail="Anything already arranged, such as a ticket or a callback, is kept."
              tone="danger"
              onConfirm={stop}
            />
            <button className="btn secondary" onClick={toggleMute} disabled={!inCall}>
              {muted ? "Unmute" : "Mute"}
            </button>
          </>
        ) : (
          <ConfirmButton
            key="start-call"
            label={state === "ended" || state === "error" ? "Start a new call" : "Start call"}
            confirmLabel="Start call"
            question="Start a voice call with RelayPay support?"
            detail="Your browser will ask to use your microphone. The conversation is logged so our team can follow up."
            variant="primary"
            // Don't hold the confirmation open while the call connects (several
            // seconds); the status line and ring show progress from here.
            onConfirm={() => void start()}
          />
        )}
      </div>

      <div className="captions">
        <Caption who="You" line={captions.user} />
        {/* Only the agent's line is announced to screen readers; the caller knows what they said. */}
        <div aria-live="polite">
          <Caption who="RelayPay" line={captions.agent} />
        </div>
      </div>
    </div>
  );
}

function Caption({ who, line }: { who: string; line: CaptionLine }) {
  if (!line.finals && !line.partial) return null;
  return (
    <p className="caption">
      <span className="who">{who}</span>
      <span>
        {line.finals}
        {line.partial ? <span className="caption-partial">{line.finals ? " " : ""}{line.partial}</span> : null}
      </span>
    </p>
  );
}

/** Vapi's "call is over" signals, which arrive through the error channel. */
export function isNormalHangUp(e: unknown): boolean {
  const text = JSON.stringify(e ?? "").toLowerCase();
  return text.includes("meeting has ended") || text.includes("ejection");
}
