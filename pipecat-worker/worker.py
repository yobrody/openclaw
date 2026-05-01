"""Pipecat worker — Twilio Media Streams inbound → STT → Gemini → TTS → audio out.

Twilio dials into /twiml on incoming call → returns TwiML pointing at /ws → WebSocket
opens, audio streams in, Pipecat pipeline handles the conversation, calls back to
the existing dashboard API at end-of-call via the `end_call` tool.
"""
from __future__ import annotations
import os
import json
import asyncio
import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, Request
from fastapi.responses import Response
from loguru import logger

import config
import tools
from prompts import render_system_prompt

# Pipecat imports
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.pipeline.runner import PipelineRunner
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.frames.frames import TTSSpeakFrame, EndFrame


# Smart-turn analyzer holds ~100MB+ of ONNX weights. Load once at worker
# startup and share across calls. Previously this was instantiated inside
# the per-call WebSocket handler, so each concurrent call piled on another
# model copy — on the 1GB Hetzner box that compounded into OOM kills,
# which surfaced as "service not running, restarted automatically" in the
# orchestrator's health alerts.
_SMART_TURN_ANALYZER: LocalSmartTurnAnalyzerV3 | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _SMART_TURN_ANALYZER
    logger.info(f"worker booting on port {config.WORKER_PORT}")
    _SMART_TURN_ANALYZER = LocalSmartTurnAnalyzerV3()
    logger.info("smart-turn analyzer loaded")
    yield
    logger.info("worker shutting down")


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/twiml")
async def twiml(request: Request):
    """Twilio hits this on incoming call. Reply with <Connect><Stream>.

    Note: Twilio strips query params from Stream URLs in the WS handshake.
    Pass per-call data via <Parameter> tags — Twilio surfaces those in the
    start event's customParameters.
    """
    form = await request.form()
    to_number = form.get("To", "")
    public_base = os.environ.get("WORKER_PUBLIC_BASE", "")
    ws_url = f"{public_base}/ws"

    twiml_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="{ws_url}">
      <Parameter name="to" value="{to_number}"/>
    </Stream>
  </Connect>
</Response>"""
    return Response(content=twiml_xml, media_type="application/xml")


async def _fetch_client_config(to_number: str) -> dict:
    """Pull per-client config (plumber_name, postcodes, business_hours, in_hours, etc.)."""
    url = f"{config.DASHBOARD_API_BASE}/inbound-lookup/{to_number}"
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            r = await client.get(url)
            if r.status_code == 200:
                return r.json()
    except Exception as e:
        logger.warning(f"inbound-lookup failed for {to_number}: {e}")
    return {}


def _wrap_tool(fn, call_sid: str):
    """Bind call_sid into a Pipecat-compatible function handler."""
    async def handler(params):
        kwargs = params.arguments or {}
        result = await fn(call_sid=call_sid, **kwargs)
        await params.result_callback(result)
    return handler


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    call_sid = ""
    # Last-ditch guard around the entire call. Any leak past this — DeepgramSTT
    # connect failure, dashboard API down during cleanup, etc. — must not take
    # the worker process down. Per-call failure is acceptable; process death
    # is not (uvicorn restart drops every other concurrent call too).
    try:
        # First Twilio frame is `connected`, second is `start` with stream + call SIDs.
        start_msg = None
        while True:
            msg = await websocket.receive_text()
            data = json.loads(msg)
            if data.get("event") == "start":
                start_msg = data
                break

        stream_sid = start_msg["start"]["streamSid"]
        call_sid = start_msg["start"]["callSid"]
        custom_params = start_msg["start"].get("customParameters", {}) or {}
        to_number = custom_params.get("to", "")
        logger.info(f"call start: sid={call_sid} to={to_number} customParams={custom_params}")

        # Per-call state
        state = tools.init_call_state(call_sid, to_number)

        # Per-tenant config from existing dashboard API
        client_config = await _fetch_client_config(to_number)
        state["plumber_mobile"] = client_config.get("plumber_mobile")
        system_prompt = render_system_prompt(client_config)

        # Twilio serializer + transport
        serializer = TwilioFrameSerializer(
            stream_sid=stream_sid,
            call_sid=call_sid,
            account_sid=config.TWILIO_ACCOUNT_SID,
            auth_token=config.TWILIO_AUTH_TOKEN,
        )
        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                serializer=serializer,
            ),
        )

        # Services
        stt = DeepgramSTTService(
            api_key=config.DEEPGRAM_API_KEY,
            model=config.DEEPGRAM_MODEL,
        )

        # LLM via OpenRouter (OpenAI-compatible). Routes Gemini 2.0 Flash through
        # Brody's OpenRouter credits — Google AI Studio direct API was rate-limited
        # to zero on free tier for this project.
        llm = OpenAILLMService(
            api_key=config.OPENROUTER_API_KEY,
            base_url="https://openrouter.ai/api/v1",
            model=config.LLM_MODEL,
        )

        # Register function-calling tools — OpenAI format schemas on context,
        # handlers bound to this call's call_sid on the LLM service.
        for tool_def in tools.TOOL_SCHEMAS:
            name = tool_def["function"]["name"]
            fn = getattr(tools, name)
            llm.register_function(name, _wrap_tool(fn, call_sid))

        tts = CartesiaTTSService(
            api_key=config.CARTESIA_API_KEY,
            settings=CartesiaTTSService.Settings(voice=config.CARTESIA_VOICE_ID),
        )

        # System prompt + tool schemas wired into context
        context = LLMContext(
            messages=[{"role": "system", "content": system_prompt}],
            tools=tools.TOOL_SCHEMAS,
        )
        # Lifespan must have run before any /ws request; if it didn't, fail loudly
        # rather than silently reloading the model per call.
        if _SMART_TURN_ANALYZER is None:
            raise RuntimeError("smart-turn analyzer not initialized; lifespan didn't run")
        user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                user_turn_strategies=UserTurnStrategies(
                    stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=_SMART_TURN_ANALYZER)]
                ),
                filter_incomplete_user_turns=True,
            ),
        )

        pipeline = Pipeline([
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ])

        task = PipelineTask(
            pipeline,
            params=PipelineParams(
                enable_metrics=True,
                enable_usage_metrics=True,
                allow_interruptions=True,
            ),
        )

        # Bot must speak first — Pipecat won't trigger the LLM without a user turn.
        # Compute opening line from client config and push it directly to TTS via
        # the transport's on_client_connected event (NOT task — that event lives
        # on the transport).
        plumber_name = client_config.get("plumber_name") or "the plumber"
        ai_name = client_config.get("ai_name") or "Dorothy"
        # Two sentences, minimal commas — Cartesia treats commas as pauses.
        opening_line = (
            f"Hi — you've reached {plumber_name}. I'm {ai_name} — "
            f"what's the issue and postcode?"
        )

        @transport.event_handler("on_client_connected")
        async def _on_connected(transport_, client):
            logger.info("client connected — speaking opening line")
            await task.queue_frames([TTSSpeakFrame(opening_line)])

        runner = PipelineRunner(handle_sigint=False)
        try:
            await runner.run(task)
        except Exception as e:
            logger.exception(f"pipeline error: {e}")
        finally:
            # Cleanup must never re-raise — dashboard API down during a Deepgram
            # outage was crashing the finally path and bringing the process with it.
            try:
                final_state = tools.get_call_state(call_sid)
                if not final_state.get("outcome"):
                    # Pipeline ended without end_call (line dropped) — record what we have
                    final_state["outcome"] = "declined"
                    final_state["summary"] = "Caller hung up before completion"
                    await tools.end_call(call_sid=call_sid, outcome="declined",
                                         summary="Caller hung up before completion")
                logger.info(f"call ended: sid={call_sid} outcome={final_state.get('outcome')}")
            except Exception as e:
                logger.exception(f"call cleanup failed (sid={call_sid}): {e}")
    except Exception as e:
        logger.exception(f"ws handler crashed (sid={call_sid}): {e}")
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("worker:app", host="0.0.0.0", port=config.WORKER_PORT, log_level="info")
