"""Voice pipeline: browser audio -> VAD -> ElevenLabs STT -> Gemini -> ElevenLabs TTS -> browser audio."""

from __future__ import annotations

import os
import time
from datetime import date

from loguru import logger
from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import LLMRunFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.elevenlabs.stt import ElevenLabsRealtimeSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.google.llm import GoogleLLMService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

import store

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

SYSTEM_PROMPT = """\
You are Maya, the voice receptionist for Lumen Health, a multi-speciality clinic. \
You talk to callers on the phone. You can do exactly three things: check a doctor's \
availability, book an appointment, and cancel an appointment.

Today is {today}.

STYLE
- This is a spoken call. Keep replies to one or two short sentences. No lists, markdown, \
emojis or symbols. Say dates naturally ("Thursday the twenty-seventh"), times as "ten thirty in the morning".
- Call check_doctor_availability ONCE per question, never several times in parallel. Leave out the date unless the caller named one. Remember everything the caller already told you (doctor, day, name, number) and never ask for it again.
- Offer at most three slots at a time. Ask one question at a time.
- Sound warm and human. Never mention tools, functions, slot ids or internal systems.

PHONE NUMBER (this is how you identify the caller; there is no login)
- Before booking or cancelling, you must have the caller's phone number from what they said out loud.
- Read the number back digit by digit, in groups, and ask "Is that correct?". \
Only after they say yes, call the tool with phone_confirmed=true. If they correct you, read the new number back again.
- Never invent or assume a number. Convert spoken digits to numerals when passing them to tools.

FLOW
1. Greet, ask how you can help.
2. Availability: ask which doctor or speciality (and day if they care), call check_doctor_availability, offer a few slots.
3. Booking: get the chosen slot, the caller's name (optional, ask once), then the phone number and its confirmation, \
then call book_appointment. Confirm doctor, day, time out loud afterwards.
4. Cancelling: get the phone number, read it back, confirm, then call cancel_appointment.
5. If a tool returns an error, explain simply and offer the next best step. Each phone number can hold one confirmed appointment.
6. If asked for anything else (medical advice, billing), politely say you only handle appointments.

EDGE CASES
- Vague request ("I need a doctor", "a consultation"): do not guess. Gently ask what it is about or which speciality they need.
- Speciality or doctor we do not have (for example plastic surgery): you do not know our roster by heart, so ALWAYS call check_doctor_availability first, even if the request sounds unlikely. Never say we lack a speciality without checking, and never invent one. If the tool finds no match, say something like "We don't have that speciality on our regular roster, but I'll note it down and our team will confirm availability and get back to you." Ask for their phone number and read it back so the team can reach them, then offer to help with any of our available doctors in the meantime.
- Unclear, garbled or surprising speech (a name, number, date, speciality): do not act on it. Ask gently, e.g. "Sorry, did you say Dr. Nair?" or "Just to check, was that the fifteenth?". Confirm before using it.
- If the caller goes quiet or says they changed their mind, respond kindly and ask what they would like to do.
"""

TOOLS = ToolsSchema(
    standard_tools=[
        FunctionSchema(
            name="check_doctor_availability",
            description="List open appointment slots. Filter by doctor name or speciality and/or a date. "
            "With no filters it returns slots for every doctor.",
            properties={
                "doctor": {
                    "type": "string",
                    "description": "Doctor name (e.g. 'Sharma') or speciality (e.g. 'cardiology'). Optional.",
                },
                "date": {"type": "string", "description": "Date as YYYY-MM-DD. Optional."},
            },
            required=[],
        ),
        FunctionSchema(
            name="book_appointment",
            description="Book a slot for the caller. Only call after the caller confirmed the phone number you read back.",
            properties={
                "slot_id": {"type": "string", "description": "slot_id exactly as returned by check_doctor_availability."},
                "phone_number": {"type": "string", "description": "Caller's phone number as digits."},
                "phone_confirmed": {
                    "type": "boolean",
                    "description": "True only if the caller said yes to your read-back of the number.",
                },
                "patient_name": {"type": "string", "description": "Caller's name, if given."},
            },
            required=["slot_id", "phone_number", "phone_confirmed"],
        ),
        FunctionSchema(
            name="cancel_appointment",
            description="Cancel the caller's confirmed appointment, found by phone number. "
            "Only call after the caller confirmed the number you read back.",
            properties={
                "phone_number": {"type": "string", "description": "Caller's phone number as digits."},
                "phone_confirmed": {
                    "type": "boolean",
                    "description": "True only if the caller said yes to your read-back of the number.",
                },
            },
            required=["phone_number", "phone_confirmed"],
        ),
    ]
)

_NOT_CONFIRMED = {
    "success": False,
    "error": "Phone number not confirmed. Read it back digit by digit and get a yes first.",
}


# ------------------------------------------------------------ tool handlers
async def check_doctor_availability(params: FunctionCallParams):
    args = params.arguments
    logger.info(f"tool check_doctor_availability {args}")
    store.publish_tool("check", "working")
    result = store.available_slots(args.get("doctor"), args.get("date"))
    store.publish_tool("check", "failed" if "error" in result else "done")
    await params.result_callback(result)


async def book_appointment(params: FunctionCallParams):
    args = params.arguments
    logger.info(f"tool book_appointment {args}")
    if not args.get("phone_confirmed"):
        return await params.result_callback(_NOT_CONFIRMED)
    store.publish_tool("book", "working")
    result = store.book(args.get("slot_id", ""), args.get("phone_number", ""), args.get("patient_name"))
    store.publish_tool("book", "done" if result.get("success") else "failed")
    await params.result_callback(result)


async def cancel_appointment(params: FunctionCallParams):
    args = params.arguments
    logger.info(f"tool cancel_appointment {args}")
    if not args.get("phone_confirmed"):
        return await params.result_callback(_NOT_CONFIRMED)
    store.publish_tool("cancel", "working")
    result = store.cancel(args.get("phone_number", ""))
    store.publish_tool("cancel", "done" if result.get("success") else "failed")
    await params.result_callback(result)


# ----------------------------------------------------------------- pipeline
async def run_bot(connection: SmallWebRTCConnection) -> None:
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )

    stt = ElevenLabsRealtimeSTTService(api_key=os.environ["ELEVENLABS_API_KEY"])
    tts = ElevenLabsTTSService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        settings=ElevenLabsTTSService.Settings(
            voice=os.getenv("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL"),  # "Sarah" (premade; library voices need a paid plan)
        ),
    )
    llm = GoogleLLMService(
        api_key=os.environ["GOOGLE_API_KEY"],
        settings=GoogleLLMService.Settings(
            model=GEMINI_MODEL,
            # Gemini 3 takes a thinking level; "minimal" keeps voice replies fast.
            **(
                {"thinking": GoogleLLMService.ThinkingConfig(thinking_level="minimal")}
                if GEMINI_MODEL.startswith("gemini-3")
                else {}
            ),
            system_instruction=SYSTEM_PROMPT.format(today=date.today().strftime("%A, %d %B %Y")),
        ),
    )
    llm.register_function("check_doctor_availability", check_doctor_availability)
    llm.register_function("book_appointment", book_appointment)
    llm.register_function("cancel_appointment", cancel_appointment)

    context = LLMContext(tools=TOOLS)
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.6)),
        ),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            aggregators.user(),
            llm,
            tts,
            transport.output(),
            aggregators.assistant(),
        ]
    )
    # RTVI (auto-enabled by the worker) streams live transcripts/bot state to the browser.
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, allow_interruptions=True),
    )

    last_apology = 0.0

    @worker.event_handler("on_pipeline_error")
    async def _on_error(_w, frame):
        # LLM failures (rate limit, 503) used to leave the caller in silence; say something instead.
        nonlocal last_apology
        if frame.processor is llm and time.monotonic() - last_apology > 8:
            last_apology = time.monotonic()
            busy = any(w in str(frame.error) for w in ("429", "503", "quota", "overloaded", "demand"))
            line = (
                "Sorry, I'm a little busy right now. Please give me a few seconds and say that again."
                if busy
                else "Sorry, I lost you for a moment. Could you say that again?"
            )
            await worker.queue_frames([TTSSpeakFrame(line)])

    @transport.event_handler("on_client_connected")
    async def _on_connected(_t, _c):
        logger.info("client connected")
        context.add_message({"role": "user", "content": "A caller just connected. Greet them."})
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def _on_disconnected(_t, _c):
        logger.info("client disconnected")
        await worker.cancel()

    await WorkerRunner(handle_sigint=False).run(worker)
