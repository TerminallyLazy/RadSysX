"""Bounded, cancelable research processes for the governed AI session broker.

Only the broker supplies an authorized, non-identifying query. The child has no
clinical database, viewer authority, shell tools, or inherited provider secrets.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import sys
import weakref
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .ai_research_worker import normalize_result, validate_research_model

_LOOP_SLOTS: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_MAX_LINE_BYTES = 128 * 1024
_MAX_OUTPUT_BYTES = 512 * 1024
RESEARCH_PROGRESS_STAGES = frozenset({"queued", "starting", "waiting_model", "searching_web", "searching_pubmed", "reading_source", "synthesizing"})


def _slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    if loop not in _LOOP_SLOTS:
        _LOOP_SLOTS[loop] = asyncio.Semaphore(2)
    return _LOOP_SLOTS[loop]


def _child_environment(api_key: str, *, provider: str = "gemini") -> dict[str, str]:
    # No HOME override, user Python path, proxy credentials, cloud project,
    # tracing credentials, OpenAI key, or clinical configuration is inherited.
    allowed = ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL")
    environment = {name: os.environ[name] for name in allowed if name in os.environ}
    environment.update({

        "LANGSMITH_TRACING": "false",
        "LANGCHAIN_TRACING_V2": "false",
    })
    if provider == "gemini":
        environment.update({"GEMINI_API_KEY":api_key,"GOOGLE_GENAI_USE_VERTEXAI":"false"})
    elif provider == "nvidia_nim":
        environment["NVIDIA_API_KEY"] = api_key
    else:
        raise ValueError("Invalid research provider")
    return environment


def _failure(code: str) -> dict[str, Any]:
    return {
        "error": code,
        "summary": "Research timed out." if code == "research_timeout" else "Research did not complete.",
        "sources": [],
        "limitations": ["The research provider or job did not respond within its time limit. No evidence review was run." if code == "research_timeout" else "The research service is unavailable or its execution limit was reached."],
        "usage": {},
    }


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
    try:
        await asyncio.wait_for(process.wait(), timeout=2)
    except asyncio.TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        await process.wait()


class ResearchSupervisor:
    """Run at most two research children per backend event loop.

    ``on_progress`` receives a safe ``{"stage": ...}`` dictionary, never model
    chunks, tool inputs, or reasoning. Cancel the awaiting task to stop the child.
    """

    def __init__(
        self,
        api_key: str,
        model: str = "gemini-3.8-flash",
        *,
        timeout_seconds: float = 120,
        provider: str = "gemini",
    ) -> None:
        validate_research_model(provider, model)
        self._provider = provider
        self._api_key = api_key
        self._model = model
        self._timeout_seconds = max(0.01, min(timeout_seconds, 120))

    async def run(
        self,
        query: str,
        on_progress: Callable[[dict[str, str]], Any] | None = None,
    ) -> dict[str, Any]:
        if not self._api_key or not isinstance(query, str) or not 1 <= len(query.strip()) <= 2000:
            return _failure("research_invalid_request")
        try:
            async with asyncio.timeout(self._timeout_seconds):
                async with _slots():
                    # Cleanup happens before releasing the concurrency slot.
                    return await self._run_child(query.strip(), on_progress)
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            return _failure("research_timeout")
        except Exception:
            # Worker stderr, model exceptions, prompts, and credentials never
            # cross the application boundary.
            return _failure("research_failed")
    async def _run_child(self, query: str, on_progress: Callable | None) -> dict[str, Any]:
        process = None
        try:
            # Fixed interpreter and entrypoint, no shell or code received from
            # the model. -I excludes user site and Python path inputs.
            spawn = asyncio.create_task(asyncio.create_subprocess_exec(
                sys.executable, "-I", "-u",
                str(Path(__file__).with_name("ai_research_worker.py")),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=_child_environment(self._api_key, provider=self._provider),
                limit=_MAX_LINE_BYTES,
            ))
            try:
                process = await asyncio.shield(spawn)
            except asyncio.CancelledError:
                # Account for a process launched just as the caller canceled.
                process = await spawn
                raise
            assert process.stdin is not None and process.stdout is not None
            request = self.worker_request(query)
            encoded = (json.dumps(request, ensure_ascii=False) + "\n").encode()
            if len(encoded) > 16384:
                raise ValueError("Worker input limit exceeded")
            process.stdin.write(encoded)
            await process.stdin.drain()
            process.stdin.close()
            total_bytes = 0
            result = None
            failure = None
            while line := await process.stdout.readline():
                total_bytes += len(line)
                if total_bytes > _MAX_OUTPUT_BYTES:
                    raise ValueError("Research output limit exceeded")
                event = json.loads(line)
                if not isinstance(event, dict):
                    raise ValueError("Invalid research event")
                if failure is not None:
                    raise ValueError("Research error must be terminal")
                if event.get("kind") == "progress":
                    stage = event.get("stage")
                    if stage in RESEARCH_PROGRESS_STAGES and on_progress is not None:
                        callback = on_progress({"stage": stage})
                        if inspect.isawaitable(callback):
                            await callback
                elif event.get("kind") == "result" and result is None:
                    result = normalize_result(event.get("result"))
                elif event == {"kind": "error", "code": "research_timeout"} and result is None:
                    failure = "research_timeout"
                else:
                    raise ValueError("Invalid research event")
            return_code = await process.wait()
            if return_code != 0 and failure:
                return _failure(failure)
            if return_code != 0 or result is None:
                return _failure("research_failed")
            return result
        finally:
            if process is not None:
                cleanup = asyncio.create_task(_stop_process(process))
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    await cleanup
                    raise

    def worker_request(self, query):
        return {"query": query, "model": self._model, "provider": self._provider}
