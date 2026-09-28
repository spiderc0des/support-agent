"use client";

/**
 * The web voice call. Vapi's Web SDK owns the microphone, speech-to-text and
 * speech output; this component only starts and stops the call and shows
 * where it stands.
 *
 * Deliberately not a chat window (brand direction): one status line, a
 * level bar, and the latest line from each side as captions.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Vapi from "@vapi-ai/web";

type CallState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ended" | "error";

const LABEL: Record<CallState, string> = {
  idle: "Ready when you are",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
  error: "Something went wrong",
};

type TranscriptMessage = { type?: string; role?: string; transcriptType?: string; transcript?: string };

export function VoiceCall({ publicKey, assistantId }: { publicKey: string; assistantId: string }) {
  const vapiRef = useRef<Vapi | null>(null);
  const [state, setState] = useState<CallState>("idle");
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [you, setYou] = useState("");
  const [agent, setAgent] = useState("");
  const [error, setError] = useState<string | null>(null);

  const configured = Boolean(publicKey && assistantId);

  useEffect(() => {
    if (!configured) return;
    const vapi = new Vapi(publicKey);
    vapiRef.current = vapi;

    vapi.on("call-start", () => setState("listening"));
    vapi.on("call-end", () => {
      setState("ended");
      setLevel(0);
      setMuted(false);
    });
    vapi.on("speech-start", () => setState("speaking"));
    vapi.on("speech-end", () => setState("listening"));
    vapi.on("volume-level", (v: number) => setLevel(v));
    vapi.on("message", (m: TranscriptMessage) => {
      if (m.type !== "transcript" || !m.transcript) return;
      if (m.role === "user") {
        setYou(m.transcript);
        if (m.transcriptType === "final") setState("thinking");
      } else if (m.role === "assistant" && m.transcriptType === "final") {
        setAgent(m.transcript);
      }
    });
    vapi.on("error", (e: unknown) => {
      console.error("[vapi]", e);
      setError("The call could not continue. Please try again.");
      setState("error");
    });

    return () => {
      void vapi.stop();
      vapi.removeAllListeners();
      vapiRef.current = null;
    };
  }, [configured, publicKey]);

  const start = useCallback(async () => {
    const vapi = vapiRef.current;
    if (!vapi) return;
    setError(null);
    setYou("");
    setAgent("");
    setState("connecting");
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access is blocked. Allow it in your browser settings to talk to support.");
      setState("error");
      return;
    }
    try {
      await vapi.start(assistantId);
    } catch (e) {
      console.error("[vapi] start failed", e);
      setError("We couldn't start the call. Please try again in a moment.");
      setState("error");
    }
  }, [assistantId]);

  const stop = useCallback(() => {
    void vapiRef.current?.stop();
  }, []);

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
            <button className="btn end" onClick={stop}>
              End call
            </button>
            <button className="btn secondary" onClick={toggleMute} disabled={!inCall}>
              {muted ? "Unmute" : "Mute"}
            </button>
          </>
        ) : (
          <button className="btn" onClick={start}>
            {state === "ended" ? "Start a new call" : "Start call"}
          </button>
        )}
      </div>

      <div className="captions" aria-live="polite">
        {you ? (
          <p className="caption">
            <span className="who">You</span>
            {you}
          </p>
        ) : null}
        {agent ? (
          <p className="caption">
            <span className="who">RelayPay</span>
            {agent}
          </p>
        ) : null}
      </div>
    </div>
  );
}
