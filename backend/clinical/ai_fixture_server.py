"""Synthetic desktop-smoke entrypoint. Never selected by normal app startup."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

if os.environ.get("RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN") != "1":
    raise RuntimeError("Synthetic Live server is available only to desktop smoke tests.")

from google.genai import types
from backend.server import app, ai_live_service
from backend.clinical import ai_research


_media = {"audioBytes": 0, "audioFrames": 0, "audioEnds": 0, "videoFrames": 0, "activeProviders": 0}
_audio_mime_types = set()
_audio_frame_sizes = set()


@app.get("/api/ai/_fixture/media", include_in_schema=False)
async def fixture_media_counters():
    """Transient counts only, in this explicitly guarded test process only."""
    return {**_media, "audioMimeTypes": sorted(_audio_mime_types), "audioFrameSizes": sorted(_audio_frame_sizes)}


class FixtureResearchSupervisor:
    """Two deterministic delayed jobs; never constructs a cloud client/child."""
    active = 0
    peak = 0

    def __init__(self, **kwargs):
        pass

    async def run(self, query, on_progress=None):
        type(self).active += 1
        type(self).peak = max(type(self).peak, type(self).active)
        try:
            number = "one" if "one" in query else "two"
            await asyncio.sleep(1.2 if number == "one" else 1.8)
            return {"summary": f"Synthetic research {number} completed.",
                    "sources": [{"id": f"fixture-{number}", "title": f"Synthetic research {number}",
                                 "url": f"https://example.com/synthetic-research-{number}"}],
                    "limitations": ["Synthetic fixture, no web research was performed."],
                    "usage": {"synthetic": True, "peakConcurrent": type(self).peak}}
        finally:
            type(self).active -= 1


class FixtureSession:
    def __init__(self):
        _media["activeProviders"] += 1
        self.queue = asyncio.Queue()
        self.setup_complete = types.LiveServerSetupComplete()
        self.started = False
        self.responses = set()
        self.finished = False
        self.background = set()

    async def say(self, text, status="IN_PROGRESS"):
        await self.queue.put(types.LiveServerMessage(server_content=types.LiveServerContent(
            interaction_status=status, turn_complete=True,
            output_transcription=types.Transcription(text=text, finished=True),
            model_turn=types.Content(parts=[types.Part(inline_data=types.Blob(
                data=b"\x00\x00" * 2400, mime_type="audio/pcm;rate=24000"))]))))

    async def filler(self):
        await asyncio.sleep(0.6)
        if not self.finished:
            await self.say("The two synthetic research tasks are still running.")

    async def close(self):
        _media["activeProviders"] -= 1
        for task in self.background:
            task.cancel()
        await asyncio.gather(*self.background, return_exceptions=True)

    async def send_client_content(self, **kwargs):
        pass

    async def send_realtime_input(self, **kwargs):
        audio = kwargs.get("audio")
        if audio is not None:
            size = len(audio.data or b"")
            _media["audioBytes"] += size
            _media["audioFrames"] += 1
            _audio_mime_types.add(audio.mime_type)
            _audio_frame_sizes.add(size)
        if kwargs.get("audio_stream_end"):
            _media["audioEnds"] += 1
        if kwargs.get("video") is not None:
            _media["videoFrames"] += 1
        if kwargs.get("text") and not self.started:
            self.started = True
            await self.say("Checking the synthetic viewer while two research tasks run.")
            await self.queue.put(types.LiveServerMessage(tool_call=types.LiveServerToolCall(function_calls=[
                types.FunctionCall(id="smoke-research-one", name="research_run", args={"query":"Synthetic public research one"}),
                types.FunctionCall(id="smoke-research-two", name="research_run", args={"query":"Synthetic public research two"}),
                types.FunctionCall(id="smoke-window", name="viewer_set_window_level", args={"windowWidth":400,"windowCenter":40})])))
            self.background.add(asyncio.create_task(self.filler()))

    async def send_tool_response(self, **kwargs):
        for response in kwargs.get("function_responses", []):
            if response.id == "smoke-window" and response.id not in self.responses:
                # Replay the same completed call to prove one app-side execution.
                await self.queue.put(types.LiveServerMessage(tool_call=types.LiveServerToolCall(function_calls=[
                    types.FunctionCall(id="smoke-window", name="viewer_set_window_level", args={"windowWidth":400,"windowCenter":40})])))
            self.responses.add(response.id)
        if not self.finished and {"smoke-window", "smoke-research-one", "smoke-research-two"} <= self.responses:
            self.finished = True
            await self.say("Synthetic viewer action completed. Both synthetic research tasks completed.", "IDLE")

    async def receive(self):
        while True:
            message = await self.queue.get()
            yield message
            if message.server_content and message.server_content.interaction_status == "IDLE":
                return


class FixtureProvider:
    @asynccontextmanager
    async def connect(self, handle=None):
        session = FixtureSession()
        try:
            yield session
        finally:
            await session.close()


class OpenAIFixtureSession(FixtureSession):
    """Exercise the alternate wire profile without constructing a cloud client."""
    async def send_context(self, text):
        pass

    async def send_audio(self, data):
        await self.send_realtime_input(audio=types.Blob(data=data, mime_type="audio/pcm;rate=24000"))

    async def send_image(self, data, mime):
        await self.send_realtime_input(video=types.Blob(data=data, mime_type=mime))

    async def send_text(self, text):
        await self.send_realtime_input(text=text)

    async def end_audio(self):
        await self.send_realtime_input(audio_stream_end=True)

    async def interrupt(self, item_id, content_index, audio_end_ms):
        pass

    async def send_tool_result(self, tool_id, name, result):
        await self.send_tool_response(function_responses=[types.FunctionResponse(id=tool_id, name=name, response=result)])

    async def receive(self):
        number = 0
        while True:
            message = await self.queue.get()
            if message.server_content:
                number += 1
                content = message.server_content
                if content.interaction_status == "IN_PROGRESS":
                    yield {"kind": "interaction", "status": "IN_PROGRESS"}
                for part in content.model_turn.parts if content.model_turn else []:
                    if part.inline_data:
                        yield {"kind": "audio", "data": part.inline_data.data,
                               "itemId": f"fixture-{number}", "contentIndex": 0}
                if content.output_transcription:
                    yield {"kind": "transcript", "role": "assistant", "text": content.output_transcription.text,
                           "finished": True, "turnId": f"fixture-{number}"}
                if content.interaction_status == "IDLE":
                    yield {"kind": "interaction", "status": "IDLE"}
            if message.tool_call:
                for call in message.tool_call.function_calls:
                    yield {"kind": "tool_call", "id": call.id, "name": call.name, "args": call.args}


class OpenAIFixtureProvider:
    @asynccontextmanager
    async def connect(self, handle=None):
        session = OpenAIFixtureSession()
        try:
            yield session
        finally:
            await session.close()


ai_live_service.config.readiness = lambda provider_id="gemini": ("configured", "Synthetic desktop smoke provider.")
ai_live_service.provider_factory = FixtureProvider
ai_live_service.openai_provider_factory = OpenAIFixtureProvider
ai_research.ResearchSupervisor = FixtureResearchSupervisor
