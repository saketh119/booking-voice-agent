import { useCallback, useEffect, useRef, useState } from "react";

const get = (u) => fetch(u).then((r) => r.json());

/** Doctors, appointments and live updates over SSE. `flash` maps ids to "booked" | "cancelled". */
export function useData(onEvent) {
  const [doctors, setDoctors] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [flash, setFlash] = useState({});
  const [online, setOnline] = useState(true);
  const cb = useRef(onEvent);
  cb.current = onEvent;

  const refresh = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([get("/api/doctors"), get("/api/appointments")]);
      setDoctors(d);
      setAppointments(a);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const es = new EventSource("/api/events");
    es.onmessage = async (m) => {
      const ev = JSON.parse(m.data);
      if (ev.type === "tool") return cb.current?.(ev); // stage updates only, no data change
      cb.current?.(ev); // before the refresh, so the call UI has it ahead of the tool's "done" event
      await refresh();
      setFlash({ [ev.slot_id]: ev.type, [ev.appointment.id]: ev.type });
      setTimeout(() => setFlash({}), 3000);
    };
    es.onerror = () => setOnline(false);
    es.onopen = () => setOnline(true);
    return () => es.close();
  }, [refresh]);

  const reset = useCallback(async () => {
    await fetch("/api/reset", { method: "POST" });
    refresh();
  }, [refresh]);

  return { doctors, appointments, flash, online, reset };
}
