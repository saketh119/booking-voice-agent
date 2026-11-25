// Dev-only gallery: /preview.html shows every Maya state. ?only=<name> shows one (for screenshots).
import { createRoot } from "react-dom/client";
import Character from "./Character.jsx";
import Phone from "./Phone.jsx";
import "./styles.css";
import "./call.css";

const q = new URLSearchParams(location.search);
const STATES = {
  ringing: { phase: "connecting" },
  connected: { phase: "connected" },
  listening: { phase: "connected", user: 0.2 },
  speaking: { phase: "connected", bot: 0.12 },
  speaking_wide: { phase: "connected", bot: 0.3 },
  thinking: { phase: "connected", awaiting: true },
  searching: { phase: "connected", stage: { kind: "check", status: "working" } },
  found: { phase: "connected", stage: { kind: "check", status: "done" } },
  not_found: { phase: "connected", stage: { kind: "check", status: "failed" } },
  booking: { phase: "connected", stage: { kind: "book", status: "working" } },
  booked: { phase: "connected", stage: { kind: "book", status: "done" } },
  cancelling: { phase: "connected", stage: { kind: "cancel", status: "working" } },
  cancelled: { phase: "connected", stage: { kind: "cancel", status: "done" } },
  ended: { phase: "ended" },
};
const only = q.get("only");
const names = only ? only.split(",") : Object.keys(STATES);

function Cell({ name }) {
  const s = STATES[name];
  const levels = { current: { user: s.user || 0, bot: s.bot || 0 } };
  const info = { current: { phase: s.phase, stage: s.stage, awaiting: !!s.awaiting, instant: true } };
  return (
    <div className="c">
      <Character levels={levels} info={info} />
      <p>{name}</p>
    </div>
  );
}
if (!q.get("phone")) createRoot(document.getElementById("root")).render(<div className="g">{names.map((n) => <Cell key={n} name={n} />)}</div>);

// /preview.html?phone=1[&text=1][&card=booked][&stage=check:working] renders the whole call screen.
if (q.get("phone")) {
  const [kind, status] = (q.get("stage") || "").split(":");
  const call = {
    phase: "connected", muted: false, seconds: 74, error: null, levels: { current: { user: 0, bot: Number(q.get("bot") || 0) } },
    stage: kind ? { kind, status } : null,
    card: q.get("card") ? { type: q.get("card"), appointment: { id: "A1", doctor_name: "Dr. Priya Nair", date: "2026-11-26", time: "15:00", phone: "9346889973" } } : null,
    lines: [
      { id: 1, role: "bot", text: "Hi, this is Maya from Lumen Health. How can I help you today?", final: true },
      { id: 2, role: "user", text: "I need to see a pediatrician tomorrow afternoon.", final: true },
      { id: 3, role: "bot", text: "Dr. Priya Nair has three o'clock and three thirty tomorrow. Which works for you?", final: true },
    ],
    end() {}, toggleMute() {}, close() {}, setCard() {},
  };
  const f = (iso) => new Date(iso + "T00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });
  const t = (x) => { const [h, m] = x.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
  document.body.style.background = "#f4f1ea";
  createRoot(document.getElementById("root")).render(<Phone call={call} fmtDay={f} fmtTime={t} initialText={q.get("text") === "1"} />);
}
