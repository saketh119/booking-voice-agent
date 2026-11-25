import { useCallback, useEffect, useRef, useState } from "react";
import Character from "./Character.jsx";

const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

const STAGE_TEXT = {
  check: { working: "Checking availability", done: "Slots found", failed: "Not on our roster" },
  book: { working: "Booking your slot", done: "Appointment confirmed", failed: "Could not book" },
  cancel: { working: "Cancelling appointment", done: "Appointment cancelled", failed: "Nothing to cancel" },
};
const MOOD_TEXT = {
  ringing: "Calling Maya",
  idle: "Go ahead, I'm listening",
  listening: "Listening",
  speaking: "Maya is speaking",
  thinking: "Thinking",
  ended: "Call ended",
};

const Icon = {
  mic: (
    <svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
  ),
  micOff: (
    <svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" /></svg>
  ),
  text: (
    <svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12h5" /></svg>
  ),
  end: (
    <svg viewBox="0 0 24 24"><path d="M3 14c5-4 13-4 18 0l-2.5 2.5-3-1.5v-2.5a11 11 0 0 0-7 0V15l-3 1.5z" /></svg>
  ),
};

function StageIcon({ kind, status }) {
  if (status === "working") return <span className="spinner" />;
  if (status === "failed") {
    return (
      <svg viewBox="0 0 40 40" className="ico shake">
        <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M20 12v10M20 27.5v.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 40 40" className="ico done">
      <circle className="ring-draw" cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="2.5" />
      {kind === "cancel" ? (
        <path className="mark-draw" d="M14 14l12 12M26 14L14 26" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      ) : (
        <path className="mark-draw" d="M12 21l6 6 11-12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export default function Phone({ call, fmtDay, fmtTime, initialText = false }) {
  const { phase, muted, seconds, lines, error, card, stage, levels, end, toggleMute, close, setCard } = call;
  const [showText, setShowText] = useState(!!initialText);
  const [unread, setUnread] = useState(false);
  const [mood, setMood] = useState("ringing");
  const feed = useRef(null);
  const info = useRef({});
  const seen = useRef(0);

  const last = lines[lines.length - 1];
  info.current = { phase, stage, awaiting: last?.role === "user" && last.final };
  const onMood = useCallback((m) => setMood(m), []);

  // New lines while the transcript is closed show a dot on the button.
  useEffect(() => {
    if (lines.length > seen.current && !showText) setUnread(true);
    seen.current = lines.length;
  }, [lines, showText]);
  useEffect(() => {
    if (phase === "connecting") {
      setShowText(false);
      setUnread(false);
      seen.current = 0;
    }
  }, [phase]);
  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: "smooth" });
  }, [lines, showText]);

  // Close the call screen shortly after the call ends (unless there is an error to read).
  useEffect(() => {
    if (phase === "ended" && !error) {
      const t = setTimeout(close, 2600);
      return () => clearTimeout(t);
    }
  }, [phase, error, close]);

  if (phase === "idle") return null;

  const appt = card?.appointment;
  const stageLabel = phase === "connected" && stage ? STAGE_TEXT[stage.kind][stage.status] : null;
  const status = error || stageLabel || MOOD_TEXT[phase === "ended" ? "ended" : mood] || "";
  const sub = phase === "connecting" ? "Connecting…" : phase === "ended" ? clock(seconds) : clock(seconds);

  return (
    <div className={"phone-wrap " + phase}>
      <div className={"phone mood-" + (phase === "ended" ? "ended" : mood)} role="dialog" aria-label="Call with Maya">
        <header className="call-head">
          <h3>Maya</h3>
          <p className="muted-light">Lumen Health · {sub}</p>
        </header>

        <div className="stage-area">
          <div className="scene"><Character levels={levels} info={info} onMood={onMood} />
          {appt && (
            <div className={"confirm " + card.type} key={appt.id + card.type}>
              <span className="tag">{card.type === "booked" ? "Booked" : "Cancelled"}</span>
              <strong>{appt.doctor_name}</strong>
              <span>{fmtDay(appt.date, true)} · {fmtTime(appt.time)}</span>
              <span className="mono">{appt.phone}</span>
              <button className="x" onClick={() => setCard(null)} aria-label="Dismiss">×</button>
            </div>
          )}
          </div>
          <div className={"call-status" + (stage && phase === "connected" ? ` has-stage ${stage.kind} ${stage.status}` : "")} key={status} role="status" aria-live="polite">
            {stage && phase === "connected" && <StageIcon kind={stage.kind} status={stage.status} />}
            <span>{status}</span>
            {(mood === "thinking" || stage?.status === "working") && phase === "connected" && <i className="dots"><b /><b /><b /></i>}
          </div>
        </div>

        <div className={"sheet" + (showText ? " open" : "")} aria-hidden={!showText}>
          <div className="sheet-head">
            <span>Transcript</span>
            <button onClick={() => setShowText(false)} aria-label="Hide transcript">Hide</button>
          </div>
          <div className="feed" ref={feed}>
            {lines.length === 0 && <p className="hint">Nothing said yet.</p>}
            {lines.map((l) => (
              <p key={l.id} className={"line " + l.role + (l.final ? "" : " interim")}><b>{l.role === "bot" ? "Maya" : "You"}</b>{l.text}</p>
            ))}
          </div>
        </div>

        <div className="controls">
          <button className={"ctl" + (muted ? " on" : "")} onClick={toggleMute} disabled={phase !== "connected"} aria-pressed={muted}>
            <span className="ci">{muted ? Icon.micOff : Icon.mic}</span>
            <em>{muted ? "Unmute" : "Mute"}</em>
          </button>
          <button className={"ctl" + (showText ? " on" : "")} onClick={() => { setShowText((v) => !v); setUnread(false); }} aria-pressed={showText}>
            <span className="ci">{Icon.text}{unread && <u className="badge" />}</span>
            <em>Transcript</em>
          </button>
          {phase === "ended" ? (
            <button className="ctl" onClick={close}><span className="ci">×</span><em>Close</em></button>
          ) : (
            <button className="ctl end" onClick={end}><span className="ci">{Icon.end}</span><em>End</em></button>
          )}
        </div>
      </div>
    </div>
  );
}
