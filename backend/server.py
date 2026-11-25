"""FastAPI app: WebRTC signalling for the voice agent + REST/SSE for the dashboard."""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

from fastapi import BackgroundTasks, FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from loguru import logger  # noqa: E402
from pipecat.transports.smallwebrtc.request_handler import (  # noqa: E402
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)

import store  # noqa: E402
from bot import run_bot  # noqa: E402

handler = SmallWebRTCRequestHandler()


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.seed()
    store.attach_loop(asyncio.get_running_loop())
    missing = [k for k in ("ELEVENLABS_API_KEY", "GOOGLE_API_KEY") if not os.getenv(k)]
    if missing:
        logger.warning(f"Missing env vars: {', '.join(missing)} (copy .env.example to .env)")
    yield
    await handler.close()


app = FastAPI(title="Lumen Health Voice Agent", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------------------------------------ voice (WebRTC)
@app.post("/api/offer")
async def offer(request: SmallWebRTCRequest, background_tasks: BackgroundTasks):
    async def on_connection(connection):
        background_tasks.add_task(run_bot, connection)

    return await handler.handle_web_request(request, on_connection)


@app.patch("/api/offer")
async def ice_candidate(request: SmallWebRTCPatchRequest):
    await handler.handle_patch_request(request)
    return {"status": "success"}


# ---------------------------------------------------------------- dashboard
@app.get("/api/doctors")
def doctors():
    return store.list_doctors_with_slots()


@app.get("/api/appointments")
def appointments():
    return store.list_appointments()


@app.post("/api/reset")
def reset():
    """Re-seed mock data (handy between demo takes)."""
    store.seed()
    return {"status": "ok"}


@app.get("/api/events")
async def events():
    """Server-sent events: 'booked' / 'cancelled' so the dashboard updates live."""
    queue = store.subscribe()

    async def stream():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            store.unsubscribe(queue)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=int(os.getenv("PORT", "7860")))
