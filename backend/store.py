"""In-memory mock data store for doctors, slots and appointments.

Seeded from data/doctors.json at startup. All mutations go through this module
and are published to subscribers (used for the dashboard's live SSE stream).
"""

from __future__ import annotations

import asyncio
import itertools
import json
import re
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

DATA_FILE = Path(__file__).parent / "data" / "doctors.json"
SLOT_TIMES = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "14:00", "14:30", "15:00", "15:30", "16:00"]
DAYS_AHEAD = 5  # working days of slots to generate

_lock = threading.RLock()
_ids = itertools.count(1001)

doctors: dict[str, dict] = {}
slots: dict[str, dict] = {}  # slot_id -> {id, doctor_id, date, time, booked_by}
appointments: dict[str, dict] = {}  # appointment_id -> record

_subscribers: set[asyncio.Queue] = set()
_loop: asyncio.AbstractEventLoop | None = None


# ----------------------------------------------------------------- helpers
def normalize_phone(raw: str) -> str:
    """Keep digits (and a leading +). '98765 43210' -> '9876543210'."""
    raw = (raw or "").strip()
    digits = re.sub(r"\D", "", raw)
    return ("+" + digits) if raw.startswith("+") else digits


def _working_days(n: int) -> list[date]:
    out, d = [], date.today()
    while len(out) < n:
        if d.weekday() < 6:  # Mon-Sat
            out.append(d)
        d += timedelta(days=1)
    return out


def seed() -> None:
    global _loop
    with _lock:
        doctors.clear(), slots.clear(), appointments.clear()
        for doc in json.loads(DATA_FILE.read_text(encoding="utf-8")):
            doctors[doc["id"]] = doc
            for i, day in enumerate(_working_days(DAYS_AHEAD)):
                # Deterministic "already taken" pattern so each doctor looks realistic.
                for j, t in enumerate(SLOT_TIMES):
                    if (i * 3 + j * 5 + len(doc["id"])) % 4 == 0:
                        continue
                    if datetime.strptime(f"{day.isoformat()} {t}", "%Y-%m-%d %H:%M") <= datetime.now():
                        continue  # don't offer slots already in the past
                    sid = f"{doc['id']}-{day.isoformat()}-{t.replace(':', '')}"
                    slots[sid] = {
                        "id": sid,
                        "doctor_id": doc["id"],
                        "date": day.isoformat(),
                        "time": t,
                        "booked_by": None,
                    }


def attach_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


# ------------------------------------------------------------- pub / sub
def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


def _publish(event: dict) -> None:
    def _push():
        for q in list(_subscribers):
            q.put_nowait(event)

    if _loop and _loop.is_running():
        _loop.call_soon_threadsafe(_push)


def publish_tool(name: str, status: str) -> None:
    """Tell the dashboard a tool is running. name: check|book|cancel, status: working|done|failed."""
    _publish({"type": "tool", "name": name, "status": status})


# ---------------------------------------------------------------- queries
def public_doctor(doc: dict) -> dict:
    return {k: doc[k] for k in ("id", "name", "speciality", "experience_years", "clinic")}


def find_doctor(query: str | None) -> dict | None:
    """Match by id, name fragment ('sharma', 'dr priya') or speciality."""
    if not query:
        return None
    q = re.sub(r"^dr\.?\s*", "", query.strip().lower())
    for d in doctors.values():
        name = d["name"].lower().replace("dr. ", "")
        if q in (d["id"].lower(), name) or q in name or name in q:
            return d
    for d in doctors.values():
        if q in d["speciality"].lower() or d["speciality"].lower() in q:
            return d
    return None


def list_doctors_with_slots() -> list[dict]:
    with _lock:
        out = []
        for d in doctors.values():
            ds = sorted(
                (s for s in slots.values() if s["doctor_id"] == d["id"]),
                key=lambda s: (s["date"], s["time"]),
            )
            out.append({**public_doctor(d), "slots": [dict(s) for s in ds]})
        return out


def list_appointments() -> list[dict]:
    with _lock:
        return sorted(appointments.values(), key=lambda a: a["created_at"], reverse=True)


def available_slots(doctor_query: str | None = None, on_date: str | None = None, limit: int = 12) -> dict:
    with _lock:
        docs = list(doctors.values())
        if doctor_query:
            doc = find_doctor(doctor_query)
            if not doc:
                return {
                    "error": f"No doctor or speciality matches '{doctor_query}'.",
                    "instruction": "Do not invent one. Tell the caller we will confirm availability and get back to them, "
                    "take their phone number, and offer the doctors listed here meanwhile.",
                    "available_doctors": [
                        f"{d['name']} ({d['speciality']})" for d in doctors.values()
                    ],
                }
            docs = [doc]
        results = []
        for d in docs:
            ds = sorted(
                (
                    s
                    for s in slots.values()
                    if s["doctor_id"] == d["id"]
                    and s["booked_by"] is None
                    and (not on_date or s["date"] == on_date)
                ),
                key=lambda s: (s["date"], s["time"]),
            )[:limit]
            results.append(
                {
                    **public_doctor(d),
                    "slots": [{"slot_id": s["id"], "date": s["date"], "time": s["time"]} for s in ds],
                }
            )
        return {"today": date.today().isoformat(), "doctors": results}


# -------------------------------------------------------------- mutations
def book(slot_id: str, phone: str, patient_name: str | None = None) -> dict:
    phone = normalize_phone(phone)
    if len(re.sub(r"\D", "", phone)) < 7:
        return {"success": False, "error": "That phone number looks too short. Ask the caller to repeat it."}
    with _lock:
        slot = slots.get(slot_id)
        if not slot:
            return {"success": False, "error": "Unknown slot_id. Call check_doctor_availability again."}
        if slot["booked_by"]:
            return {"success": False, "error": "That slot was just taken. Offer another slot."}
        existing = next((a for a in appointments.values() if a["phone"] == phone and a["status"] == "confirmed"), None)
        if existing:
            return {
                "success": False,
                "error": "Caller already has a confirmed appointment. They must cancel it before booking another.",
                "existing_appointment": _speakable(existing),
            }
        doc = doctors[slot["doctor_id"]]
        appt = {
            "id": f"APT-{next(_ids)}",
            "doctor_id": doc["id"],
            "doctor_name": doc["name"],
            "speciality": doc["speciality"],
            "slot_id": slot_id,
            "date": slot["date"],
            "time": slot["time"],
            "phone": phone,
            "patient_name": patient_name,
            "status": "confirmed",
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        slot["booked_by"] = phone
        appointments[appt["id"]] = appt
    _publish({"type": "booked", "appointment": appt, "slot_id": slot_id})
    return {"success": True, "appointment": _speakable(appt)}


def cancel(phone: str) -> dict:
    phone = normalize_phone(phone)
    with _lock:
        appt = next((a for a in appointments.values() if a["phone"] == phone and a["status"] == "confirmed"), None)
        if not appt:
            return {"success": False, "error": "No confirmed appointment found for that phone number."}
        appt["status"] = "cancelled"
        appt["cancelled_at"] = datetime.now().isoformat(timespec="seconds")
        if appt["slot_id"] in slots:
            slots[appt["slot_id"]]["booked_by"] = None
    _publish({"type": "cancelled", "appointment": appt, "slot_id": appt["slot_id"]})
    return {"success": True, "cancelled": _speakable(appt)}


def _speakable(a: dict) -> dict:
    d = datetime.strptime(f"{a['date']} {a['time']}", "%Y-%m-%d %H:%M")
    return {
        "appointment_id": a["id"],
        "doctor": a["doctor_name"],
        "speciality": a["speciality"],
        "when": d.strftime("%A, %d %B at %I:%M %p"),
    }
