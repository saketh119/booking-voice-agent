import { useCallback, useEffect, useRef, useState } from "react";
import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { playConnected, playEnd, startRing } from "./sounds.js";

/** Owns the Pipecat client and exposes call state for the phone UI. */
export function useCall() {
  const [phase, setPhase] = useState("idle"); // idle | connecting | connected | ended
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [lines, setLines] = useState([]); // {id, role, text, final}
  const [error, setError] = useState(null);
  const [card, setCard] = useState(null); // booking/cancel confirmation shown in the phone
  const [stage, setStage] = useState(null); // {kind: check|book|cancel, status: working|done|failed}
  const stageRef = useRef({ start: 0, timers: [], pending: null });
  const levels = useRef({ user: 0, bot: 0 });
  const client = useRef(null);
  const audioEl = useRef(null);
  const stopRing = useRef(null);
  const timer = useRef(null);
  const seq = useRef(0);

  const cleanupTimers = () => {
    stopRing.current?.();
    stopRing.current = null;
    clearInterval(timer.current);
  };

  const pushLine = (role, text, final) =>
    setLines((prev) => {
      const last = prev[prev.length - 1];
      // Interim user transcript is replaced in place until it finalises.
      if (role === "user" && last?.role === "user" && !last.final) {
        return [...prev.slice(0, -1), { ...last, text, final }];
      }
      return [...prev, { id: ++seq.current, role, text, final }];
    });

  const clearStage = () => {
    stageRef.current.timers.forEach(clearTimeout);
    stageRef.current.timers = [];
    stageRef.current.pending = null;
    setStage(null);
  };

  /** Live events from the backend: tool start/finish drive the stage animation. */
  const onEvent = useCallback((ev) => {
    const st = stageRef.current;
    if (ev.type === "booked" || ev.type === "cancelled") {
      st.pending = ev; // shown as a card once the stage animation resolves
      return;
    }
    if (ev.type !== "tool") return;
    st.timers.forEach(clearTimeout);
    st.timers = [];
    if (ev.status === "working") {
      st.start = Date.now();
      setStage({ kind: ev.name, status: "working" });
      return;
    }
    // Tools finish in milliseconds; keep the "working" state visible long enough to read.
    const wait = Math.max(0, 1500 - (Date.now() - st.start));
    st.timers.push(
      setTimeout(() => {
        setStage({ kind: ev.name, status: ev.status });
        if (ev.status === "done" && st.pending) {
          setCard(st.pending);
          st.pending = null;
        }
        st.timers.push(setTimeout(() => setStage(null), 2600));
      }, wait)
    );
  }, []);

  const markConnected = useCallback(() => {
    setPhase((p) => {
      if (p !== "connecting") return p;
      cleanupTimers();
      playConnected();
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      return "connected";
    });
  }, []);

  const end = useCallback(async () => {
    cleanupTimers();
    clearStage();
    const c = client.current;
    client.current = null;
    setPhase((p) => (p === "idle" ? p : "ended"));
    playEnd();
    try {
      await c?.disconnect();
    } catch {
      /* already closed */
    }
    if (audioEl.current) audioEl.current.srcObject = null;
    levels.current = { user: 0, bot: 0 };
  }, []);

  const start = useCallback(async () => {
    setLines([]);
    setCard(null);
    clearStage();
    setError(null);
    setSeconds(0);
    setMuted(false);
    setPhase("connecting");
    stopRing.current = startRing();

    if (!audioEl.current) {
      audioEl.current = document.createElement("audio");
      audioEl.current.autoplay = true;
      document.body.appendChild(audioEl.current); // attached elements play more reliably
    }
    const c = new PipecatClient({
      transport: new SmallWebRTCTransport(),
      enableMic: true,
      enableCam: false,
      callbacks: {
        onBotReady: markConnected,
        onBotStartedSpeaking: markConnected,
        onUserInput: (d) => d.text?.trim() && pushLine("user", d.text, d.final),
        onBotOutput: (d) => {
          // Pipecat re-sends each sentence as it is spoken (new -> in-progress -> completed); keep the first only.
          if (d.output_type !== "sentence" || !d.text?.trim() || d.will_be_spoken === false) return;
          if (d.spoken_status && d.spoken_status !== "new") return;
          pushLine("bot", d.text, true);
        },
        onLocalAudioLevel: (l) => (levels.current.user = l),
        onRemoteAudioLevel: (l) => (levels.current.bot = l),
        onTrackStarted: (track, p) => {
          // The WebRTC transport reports remote tracks without a participant, so only skip local ones.
          if (track.kind === "audio" && !p?.local) {
            audioEl.current.srcObject = new MediaStream([track]);
            audioEl.current.play().catch(() => {});
          }
        },
        onDisconnected: () => client.current && end(),
        onError: () => setError("Connection problem"),
      },
    });
    client.current = c;
    try {
      await c.connect({ webrtcRequestParams: { endpoint: "/api/offer" } });
    } catch (e) {
      cleanupTimers();
      client.current = null;
      setError(
        /permission|denied|NotAllowed/i.test(String(e)) ? "Microphone blocked" : "Cannot reach the agent"
      );
      setPhase("ended");
    }
  }, [end, markConnected]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    client.current?.enableMic(!next);
    setMuted(next);
  }, [muted]);

  const close = useCallback(() => {
    setPhase("idle");
    setCard(null);
  }, []);

  useEffect(
    () => () => {
      cleanupTimers();
      client.current?.disconnect();
    },
    []
  );

  return { phase, muted, seconds, lines, error, card, setCard, stage, onEvent, levels, start, end, toggleMute, close };
}
