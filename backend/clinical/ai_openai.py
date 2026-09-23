"""Bounded OpenAI Realtime transport; application authority stays in the broker.

Each connection is a fresh provider conversation. Nothing in this module logs or
persists credentials, audio, frames, prompts, or provider error details.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import re
from contextlib import asynccontextmanager

from .ai_provider import SYSTEM_INSTRUCTION
from .ai_tools import DESCRIPTIONS, TOOL_MODELS

MODEL = "gpt-realtime-2.1-mini"
URL = f"wss://api.openai.com/v1/realtime?model={MODEL}"
MAX_WIRE_BYTES = 1024 * 1024
MAX_TRACKED_ITEMS = 512
IO_TIMEOUT = 5
SETUP_TIMEOUT = 20
_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")
_WIRE_LOGGER = logging.Logger("radsysx.openai.realtime.private")
_WIRE_LOGGER.disabled = True

_MESSAGES = {
    "provider_auth": "OpenAI rejected the API credential or model permission.",
    "provider_quota": "OpenAI reports exhausted API quota or a rate limit.",
    "provider_configuration": "OpenAI rejected the requested Realtime configuration.",
    "provider_unavailable": "OpenAI Realtime connection failed. Retry the session.",
    "provider_protocol": "OpenAI returned an unsupported Realtime event.",
    "provider_limit": "The Realtime connection reached its safety limit. Start a new session.",
}


class OpenAIProviderError(ConnectionError):
    def __init__(self, code="provider_unavailable"):
        self.code = code if code in _MESSAGES else "provider_unavailable"
        super().__init__(_MESSAGES[self.code])


def _provider_error(error):
    """Classify without retaining exception text, request URLs or server messages."""
    if isinstance(error, OpenAIProviderError):
        return error
    if isinstance(error, dict):
        code, kind = error.get("code"), error.get("type")
        status = None
    else:
        code = getattr(error, "code", None)
        kind = None
        status = getattr(getattr(error, "response", None), "status_code", None)
    if code in {"invalid_api_key", "invalid_auth", "permission_denied"} or status in {401, 403}:
        return OpenAIProviderError("provider_auth")
    if code in {"insufficient_quota", "rate_limit_exceeded", "billing_hard_limit_reached"} or status == 429:
        return OpenAIProviderError("provider_quota")
    if code in {"model_not_found", "invalid_model", "invalid_value", "unknown_parameter"} or kind == "invalid_request_error" or status in {400, 404}:
        return OpenAIProviderError("provider_configuration")
    return OpenAIProviderError()


def _identifier(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise OpenAIProviderError("provider_protocol")
    return value


def _decode_event(raw):
    if not isinstance(raw, (str, bytes)) or len(raw) > MAX_WIRE_BYTES:
        raise OpenAIProviderError("provider_protocol")
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise OpenAIProviderError("provider_protocol") from None
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        raise OpenAIProviderError("provider_protocol")
    return value


def _encode(value):
    try:
        raw = json.dumps(value, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    except (ValueError, TypeError):
        raise ValueError("Invalid Realtime input") from None
    if len(raw) > MAX_WIRE_BYTES:
        raise ValueError("Realtime input exceeds its size limit")
    return raw


class OpenAIRealtimeProvider:
    def __init__(self, settings, *, _ws_factory=None):
        self.settings = settings
        self._ws_factory = _ws_factory

    def config(self):
        return {
            "type": "realtime", "model": MODEL, "output_modalities": ["audio"],
            "audio": {
                "input": {"format": {"type": "audio/pcm", "rate": 24000},
                          "transcription": {"model": "gpt-4o-mini-transcribe"},
                          "turn_detection": {"type": "server_vad", "create_response": False,
                                             "interrupt_response": False}},
                "output": {"format": {"type": "audio/pcm", "rate": 24000},
                           "voice": self.settings.openai_voice},
            },
            "reasoning": {"effort": "low"},
            "instructions": SYSTEM_INSTRUCTION,
            "tools": [{"type": "function", "name": name, "description": DESCRIPTIONS[name],
                       "parameters": model.model_json_schema()} for name, model in TOOL_MODELS.items()],
            "tool_choice": "auto", "max_output_tokens": 4096,
        }

    def _validate_ack(self, event, expected):
        session = event.get("session")
        if not isinstance(session, dict):
            raise OpenAIProviderError("provider_configuration")
        audio = session.get("audio") or {}
        incoming, outgoing = audio.get("input") or {}, audio.get("output") or {}
        vad = incoming.get("turn_detection") or {}
        tool_names = {t.get("name") for t in session.get("tools", []) if isinstance(t, dict) and t.get("type") == "function"}
        valid = (
            session.get("type") == "realtime" and session.get("model") == MODEL
            and session.get("output_modalities") == ["audio"]
            and incoming.get("format") == {"type": "audio/pcm", "rate": 24000}
            and outgoing.get("format") == {"type": "audio/pcm", "rate": 24000}
            and outgoing.get("voice") == expected["audio"]["output"]["voice"]
            and (incoming.get("transcription") or {}).get("model") == "gpt-4o-mini-transcribe"
            and vad.get("type") == "server_vad" and vad.get("create_response") is False
            and vad.get("interrupt_response") is False
            and (session.get("reasoning") or {}).get("effort") == "low"
            and tool_names == set(TOOL_MODELS)
        )
        if not valid:
            raise OpenAIProviderError("provider_configuration")

    @asynccontextmanager
    async def connect(self, handle=None):
        # OpenAI has no equivalent to Gemini's acknowledged resumption handle.
        # In particular, never replay prior function calls/results here.
        key = self.settings.openai_api_key
        if not key:
            raise OpenAIProviderError("provider_auth")
        factory = self._ws_factory
        if factory is None:
            from websockets.asyncio.client import connect
            factory = connect
        try:
            async with factory(URL, additional_headers={"Authorization": f"Bearer {key}"},
                               proxy=None, open_timeout=SETUP_TIMEOUT, close_timeout=2,
                               ping_interval=20, ping_timeout=20, max_size=MAX_WIRE_BYTES,
                               max_queue=16, logger=_WIRE_LOGGER) as socket:
                transport = _OpenAISession(socket)
                try:
                    config = self.config()
                    async with asyncio.timeout(SETUP_TIMEOUT):
                        await transport._send({"type": "session.update", "session": config})
                        for _ in range(32):
                            event = _decode_event(await socket.recv())
                            if event["type"] == "error":
                                raise _provider_error(event.get("error") or {})
                            if event["type"] == "session.updated":
                                self._validate_ack(event, config)
                                break
                        else:
                            raise OpenAIProviderError("provider_protocol")
                    yield transport
                finally:
                    transport._closed = True
                    transport._clear()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            raise _provider_error(error) from None


class _OpenAISession:
    def __init__(self, socket):
        self._socket = socket
        self._lock = asyncio.Lock()
        self._closed = False
        self._active = None
        self._requested = False
        self._want_response = False
        self._cancel_requested = False
        self._speaking = False
        self._awaiting_commit = False
        self._audio_bytes = 0
        self._interaction = "IDLE"
        self._cancelled = set()
        self._responses = set()
        self._staged = {}
        self._calls = {}
        self._audio = {}
        self._transcripts = {}

    def _clear(self):
        for value in (self._cancelled, self._responses, self._staged, self._calls, self._audio, self._transcripts):
            value.clear()

    async def _send(self, event):
        if self._closed:
            raise OpenAIProviderError()
        raw = _encode(event)
        try:
            await asyncio.wait_for(self._socket.send(raw), IO_TIMEOUT)
        except asyncio.CancelledError:
            self._closed = True
            await self._close_socket()
            raise
        except Exception:
            # A failed write is ambiguous. Do not replay it on this connection.
            self._closed = True
            await self._close_socket()
            raise OpenAIProviderError() from None

    async def _close_socket(self):
        try:
            await asyncio.wait_for(self._socket.close(), 2)
        except (Exception, asyncio.CancelledError):
            pass

    def _bounded(self, mapping, key):
        if key not in mapping and len(mapping) >= MAX_TRACKED_ITEMS:
            raise OpenAIProviderError("provider_limit")

    async def _create_if_ready(self):
        if self._want_response and not (self._active or self._requested or self._speaking or self._awaiting_commit):
            self._want_response = False
            self._requested = True
            await self._send({"type": "response.create"})

    async def _cancel_active(self):
        if self._active and self._active not in self._cancelled:
            self._cancelled.add(self._active)
            await self._send({"type": "response.cancel", "response_id": self._active})
        elif self._requested:
            self._cancel_requested = True

    async def send_audio(self, data):
        if not isinstance(data, bytes) or not data or len(data) % 2 or len(data) > 24000:
            raise ValueError("Invalid 24 kHz PCM audio")
        async with self._lock:
            await self._send({"type": "input_audio_buffer.append", "audio": base64.b64encode(data).decode("ascii")})
            self._audio_bytes += len(data)

    async def end_audio(self):
        async with self._lock:
            if self._awaiting_commit or not self._audio_bytes:
                return
            if self._audio_bytes < 4800:  # Realtime requires at least 100 ms.
                await self._send({"type": "input_audio_buffer.clear"})
                self._audio_bytes = 0
                self._speaking = False
                return
            self._awaiting_commit = True
            await self._send({"type": "input_audio_buffer.commit"})

    async def _text(self, text, respond):
        if not isinstance(text, str) or not text.strip() or len(text) > 32000:
            raise ValueError("Invalid Realtime text")
        async with self._lock:
            await self._send({"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                              "content": [{"type": "input_text", "text": text}]}})
            if respond:
                self._want_response = True
                await self._create_if_ready()

    async def send_text(self, text):
        await self._text(text, True)

    async def send_context(self, text):
        await self._text(text, False)

    async def send_image(self, data, mime):
        if (not isinstance(data, bytes) or not data or len(data) > 256 * 1024
                or mime not in {"image/jpeg", "image/png"}
                or (mime == "image/jpeg" and not data.startswith(b"\xff\xd8\xff"))
                or (mime == "image/png" and not data.startswith(b"\x89PNG\r\n\x1a\n"))):
            raise ValueError("Invalid Realtime image")
        async with self._lock:
            # The server generates the item ID. We don't address input images
            # later, so no client ID (and no provider-specific ID limit) is needed.
            await self._send({"type": "conversation.item.create", "item": {
                              "type": "message", "role": "user", "content": [{"type": "input_image",
                              "image_url": f"data:{mime};base64," + base64.b64encode(data).decode("ascii")}]}})

    async def send_tool_result(self, tool_id, name, result):
        async with self._lock:
            call = self._calls.get(tool_id)
            if call is None or call["name"] != name:
                raise ValueError("Unknown Realtime tool call")
            output = _encode(result)
            if len(output) > 65536:
                raise ValueError("Realtime tool result exceeds its size limit")
            if call.get("output") is not None:
                if call["output"] != output:
                    raise ValueError("Conflicting Realtime tool result")
                if not call.get("output_sent"):
                    raise OpenAIProviderError()
                return
            # Mark before write: a dropped acknowledgement must not repeat a
            # function result, even if the caller attempts delivery again.
            call["output"] = output
            await self._send({"type": "conversation.item.create", "item": {"type": "function_call_output",
                              "call_id": tool_id, "output": output}})
            call["output_sent"] = True
            self._want_response = True
            await self._create_if_ready()

    async def interrupt(self, item_id, content_index, audio_end_ms):
        async with self._lock:
            if type(content_index) is not int or type(audio_end_ms) is not int:
                raise ValueError("Invalid Realtime playback receipt")
            item = self._audio.get((item_id, content_index))
            if item is None or not 0 <= audio_end_ms <= item["bytes"] // 48:
                raise ValueError("Invalid Realtime playback receipt")
            previous = item.get("truncated")
            if previous is not None and audio_end_ms >= previous:
                return
            response_id = item["response"]
            already_cancelled = response_id in self._cancelled
            self._cancelled.add(response_id)
            if self._active == response_id and not already_cancelled:
                # Only cancel the response that produced this playback item.
                await self._send({"type": "response.cancel", "response_id": response_id})
            item["truncated"] = audio_end_ms
            await self._send({"type": "conversation.item.truncate", "item_id": item_id,
                              "content_index": content_index, "audio_end_ms": audio_end_ms})

    def _interaction_event(self, events):
        pending = any(call.get("output") is None for call in self._calls.values())
        status = "IN_PROGRESS" if self._active or self._requested or pending else "IDLE"
        if status != self._interaction:
            self._interaction = status
            events.append({"kind": "interaction", "status": status})

    def _transcript(self, event, role, field, finished):
        item_id = _identifier(event.get("item_id"))
        index = event.get("content_index", 0)
        if type(index) is not int or not 0 <= index <= 16:
            raise OpenAIProviderError("provider_protocol")
        response_id = event.get("response_id")
        if role == "assistant" and response_id in self._cancelled:
            return []
        key = (role, item_id, index)
        self._bounded(self._transcripts, key)
        state = self._transcripts.setdefault(key, {"text": "", "finished": False})
        text = event.get(field, "")
        if not isinstance(text, str) or len(text) > 32000:
            raise OpenAIProviderError("provider_protocol")
        if state["finished"]:
            return []
        if finished:
            # Done contains the full text, whereas deltas have already been
            # rendered/persisted. A final marker may therefore have empty text.
            text = text[len(state["text"]):] if text.startswith(state["text"]) else ""
        if len(state["text"]) + len(text) > 32000:
            raise OpenAIProviderError("provider_limit")
        state["text"] += text
        state["finished"] = finished
        return [{"kind": "transcript", "role": role, "text": text, "finished": finished,
                 "turnId": item_id}]

    def _stage_call(self, response_id, item):
        if not isinstance(item, dict) or item.get("type") != "function_call":
            return
        if response_id in self._cancelled:
            return
        if response_id != self._active:
            raise OpenAIProviderError("provider_protocol")
        call_id, name = _identifier(item.get("call_id")), item.get("name")
        arguments = item.get("arguments")
        if not isinstance(name, str) or len(name) > 128 or not isinstance(arguments, str) or len(arguments) > 65536:
            raise OpenAIProviderError("provider_protocol")
        try:
            args = json.loads(arguments)
        except ValueError:
            raise OpenAIProviderError("provider_protocol") from None
        if not isinstance(args, dict):
            raise OpenAIProviderError("provider_protocol")
        calls = self._staged.setdefault(response_id, {})
        if len(calls) >= 16 and call_id not in calls:
            raise OpenAIProviderError("provider_limit")
        call = {"id": call_id, "name": name, "args": args}
        if call_id in calls and calls[call_id] != call:
            raise OpenAIProviderError("provider_protocol")
        calls[call_id] = call

    async def _handle(self, event):
        events = []
        kind = event["type"]
        async with self._lock:
            if kind == "error":
                details = event.get("error") or {}
                # VAD can commit first while a manual audio_end is in flight.
                if details.get("code") == "input_audio_buffer_commit_empty":
                    self._awaiting_commit = False
                    return []
                raise _provider_error(details)
            if kind == "input_audio_buffer.speech_started":
                self._speaking = True
                await self._cancel_active()
                events.append({"kind": "interrupted"})
            elif kind == "input_audio_buffer.speech_stopped":
                self._speaking = False
                self._awaiting_commit = True
            elif kind == "input_audio_buffer.committed":
                self._speaking = False
                self._awaiting_commit = False
                self._audio_bytes = 0
                self._want_response = True
                await self._create_if_ready()
            elif kind == "response.created":
                response_id = _identifier((event.get("response") or {}).get("id"))
                if self._active or response_id in self._responses:
                    raise OpenAIProviderError("provider_protocol")
                self._bounded(self._responses, response_id)
                self._responses.add(response_id)
                self._active, self._requested = response_id, False
                if self._cancel_requested:
                    self._cancel_requested = False
                    await self._cancel_active()
            elif kind == "response.output_audio.delta":
                response_id = _identifier(event.get("response_id"))
                if response_id in self._cancelled:
                    return []
                if response_id != self._active:
                    raise OpenAIProviderError("provider_protocol")
                item_id, index = _identifier(event.get("item_id")), event.get("content_index")
                if type(index) is not int or not 0 <= index <= 16:
                    raise OpenAIProviderError("provider_protocol")
                try:
                    data = base64.b64decode(event.get("delta"), validate=True)
                except (ValueError, TypeError, binascii.Error):
                    raise OpenAIProviderError("provider_protocol") from None
                if not data or len(data) % 2 or len(data) > 512 * 1024:
                    raise OpenAIProviderError("provider_protocol")
                key = (item_id, index)
                self._bounded(self._audio, key)
                item = self._audio.setdefault(key, {"response": response_id, "bytes": 0})
                if item["response"] != response_id:
                    raise OpenAIProviderError("provider_protocol")
                item["bytes"] += len(data)
                events.append({"kind": "audio", "data": data, "itemId": item_id, "contentIndex": index})
            elif kind in {"response.output_audio_transcript.delta", "response.output_text.delta"}:
                events.extend(self._transcript(event, "assistant", "delta", False))
            elif kind in {"response.output_audio_transcript.done", "response.output_text.done"}:
                events.extend(self._transcript(event, "assistant", "transcript" if "transcript" in kind else "text", True))
            elif kind == "conversation.item.input_audio_transcription.delta":
                events.extend(self._transcript(event, "user", "delta", False))
            elif kind == "conversation.item.input_audio_transcription.completed":
                events.extend(self._transcript(event, "user", "transcript", True))
            elif kind == "conversation.item.input_audio_transcription.failed":
                events.append({"kind": "error", "code": "provider_unavailable", "message": "Audio transcription failed."})
            elif kind == "response.function_call_arguments.done":
                response_id = _identifier(event.get("response_id"))
                self._stage_call(response_id, {**event, "type": "function_call"})
            elif kind == "response.output_item.done":
                response_id = _identifier(event.get("response_id"))
                item = event.get("item") or {}
                if item.get("status") == "completed":
                    self._stage_call(response_id, item)
            elif kind == "response.done":
                response = event.get("response") or {}
                response_id = _identifier(response.get("id"))
                if response_id not in self._responses:
                    raise OpenAIProviderError("provider_protocol")
                if response_id != self._active:
                    return []  # A repeated terminal event cannot dispatch again.
                if response.get("status") == "cancelled":
                    self._cancelled.add(response_id)
                completed = response.get("status") == "completed" and response_id not in self._cancelled
                if completed:
                    output = response.get("output") or []
                    if not isinstance(output, list) or len(output) > 32:
                        raise OpenAIProviderError("provider_protocol")
                    # Only the authoritative final output authorizes dispatch;
                    # argument.done also occurs for cancelled/incomplete calls.
                    for item in output:
                        if not isinstance(item, dict) or item.get("status") != "completed" or item.get("type") != "function_call":
                            continue
                        self._stage_call(response_id, item)
                        call = self._staged[response_id][item["call_id"]]
                        existing = self._calls.get(call["id"])
                        if existing:
                            if any(existing[key] != call[key] for key in ("name", "args")):
                                raise OpenAIProviderError("provider_protocol")
                            continue
                        self._bounded(self._calls, call["id"])
                        self._calls[call["id"]] = {**call, "output": None}
                        events.append({"kind": "tool_call", **call})
                elif response.get("status") == "failed":
                    error = _provider_error((response.get("status_details") or {}).get("error") or {})
                    events.append({"kind": "error", "code": error.code, "message": str(error)})
                elif response.get("status") == "incomplete":
                    events.append({"kind": "error", "code": "provider_unavailable", "message": "OpenAI did not complete this response."})
                self._staged.pop(response_id, None)
                self._active = None
                await self._create_if_ready()
            self._interaction_event(events)
        return events

    async def receive(self):
        try:
            while not self._closed:
                event = _decode_event(await self._socket.recv())
                for normalized in await self._handle(event):
                    yield normalized
            # A write can close the socket while this generator is suspended
            # at a yielded event. Normal exhaustion would spin the shared loop.
            raise OpenAIProviderError()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._closed = True
            safe = _provider_error(error)
            yield {"kind": "error", "code": safe.code, "message": str(safe)}
            raise safe from None
