import { useMemo, useState } from "react";
import { useCall } from "./useCall.js";
import { useData } from "./useData.js";
import Phone from "./Phone.jsx";

const fmtDay = (iso, long) =>
  new Date(iso + "T00:00").toLocaleDateString("en-IN", long
    ? { weekday: "long", day: "numeric", month: "short" }
    : { weekday: "short", day: "numeric" });

const fmtTime = (t) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export default function App() {
  const call = useCall();
  const { doctors, appointments, flash, online, reset } = useData(call.onEvent);
  const [day, setDay] = useState(null);

  const days = useMemo(() => {
    const set = new Set();
    doctors.forEach((d) => d.slots.forEach((s) => set.add(s.date)));
    return [...set].sort();
  }, [doctors]);
  const activeDay = day && days.includes(day) ? day : days[0];
  const live = call.phase === "connecting" || call.phase === "connected";

  return (
    <div className={"shell" + (call.phase !== "idle" ? " calling" : "")}>
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden />
          <div>
            <h1>Lumen Health</h1>
            <p>Reception desk</p>
          </div>
        </div>
        <div className="top-right">
          <span className={"status " + (online ? "on" : "off")}>{online ? "Agent online" : "Backend offline"}</span>
          <button className="btn ghost" onClick={reset} title="Restore mock data">Reset</button>
          <button className="btn primary" onClick={call.start} disabled={live || !online}>
            {live ? "On call" : "Try call"}
          </button>
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <div className="panel-head">
            <h2>Doctors</h2>
            <div className="days" role="tablist">
              {days.map((d) => (
                <button key={d} role="tab" aria-selected={d === activeDay}
                  className={"day" + (d === activeDay ? " sel" : "")} onClick={() => setDay(d)}>
                  {fmtDay(d)}
                </button>
              ))}
            </div>
          </div>
          <ul className="docs">
            {doctors.map((doc) => {
              const slots = doc.slots.filter((s) => s.date === activeDay);
              return (
                <li key={doc.id} className="doc">
                  <div className="doc-id">
                    <span className="avatar">{doc.name.replace("Dr. ", "").split(" ").map((w) => w[0]).join("")}</span>
                    <div>
                      <strong>{doc.name}</strong>
                      <span>{doc.speciality} · {doc.experience_years} yrs</span>
                    </div>
                  </div>
                  <div className={"slots" + (call.stage?.kind === "check" && call.stage.status === "working" ? " scanning" : "")}>
                    {slots.length === 0 && <span className="muted">No slots</span>}
                    {slots.map((s) => (
                      <span key={s.id}
                        className={"slot" + (s.booked_by ? " taken" : "") + (flash[s.id] ? " flash-" + flash[s.id] : "")}>
                        {fmtTime(s.time)}
                      </span>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Appointments</h2>
            <span className="count">{appointments.filter((a) => a.status === "confirmed").length} upcoming</span>
          </div>
          {appointments.length === 0 ? (
            <p className="empty">Nothing booked yet.<br />Start a call to book one.</p>
          ) : (
            <ul className="appts">
              {appointments.map((a) => (
                <li key={a.id} className={"appt " + a.status + (flash[a.id] ? " flash-" + flash[a.id] : "")}>
                  <div>
                    <strong>{a.patient_name || "Caller"}</strong>
                    <span className="mono">{a.phone}</span>
                  </div>
                  <div>
                    <span>{a.doctor_name}</span>
                    <span className="muted">{fmtDay(a.date, true)} · {fmtTime(a.time)}</span>
                  </div>
                  <span className={"pill " + a.status}>{a.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <Phone call={call} fmtDay={fmtDay} fmtTime={fmtTime} />
    </div>
  );
}
