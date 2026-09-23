"""Owned, cancellable text chat and research without a Realtime connection."""
from __future__ import annotations

import asyncio
import json
from fastapi import HTTPException

from .ai_research import ResearchSupervisor, RESEARCH_PROGRESS_STAGES
from .ai_repository import TERMINAL_TOOLS
from .contracts import parse_iso_z, utc_now


def text_context(state):
    # No identifiers, patient labels, arbitrary strings, reports or pixels.
    fields = {"index", "imageIndex", "imageCount", "numImageFrames", "windowWidth", "windowCenter", "rows", "columns", "zoom", "rotation"}
    output = {key: value for key, value in state.items() if key in fields and isinstance(value, (int, float)) and not isinstance(value, bool)}
    modality = state.get("modality")
    if isinstance(modality, str) and modality in {"CT", "MR", "CR", "DX", "US", "PT", "NM", "MG", "OT"}:
        output["modality"] = modality
    output["series"] = [text_context({key: value for key, value in item.items() if key != "series"}) for item in state.get("series", [])[:12] if isinstance(item, dict)] if isinstance(state.get("series"), list) else []
    return output


class ChatSupervisor(ResearchSupervisor):
    def __init__(self, *args, context, history, **kwargs):
        super().__init__(*args, **kwargs)
        self.context, self.history = context, history

    def worker_request(self, query):
        request = {**super().worker_request(query), "mode": "chat", "context": self.context, "history": list(self.history)}
        while request["history"] and len(json.dumps(request, ensure_ascii=False).encode()) > 16000:
            del request["history"][:2]
        return request


class TextService:
    def __init__(self, live):
        self.live = live
        self.repo = live.repository
        self.tasks = {}
        self.owners = {}

    async def create(self, request, actor):
        from .ai_live import clean_context
        async with self.live.owner_lock(actor):
            self.live.require_research_settings(actor)
            context = clean_context(request.viewer_context)
            if context.get("privacyClass") == "phi-bearing":
                raise HTTPException(403, "Patient-bearing context is not supported in this release.")
            if self.live.config_for(actor).research_provider == "codex":
                await self.live.codex.status(actor)
                self.live.require_research_settings(actor)
            try:
                provider, _, model = self.live.config_for(actor).research_configuration()
            except ValueError:
                raise HTTPException(503, "Configure an available text and research model in Settings.") from None
            row = self.repo.create(actor, context, request.attestation, "ready", model, text_provider=provider)
            self.live.audit(row, actor, row["sessionId"])
            return row

    def require(self, session_id, actor, version=None):
        self.live.require_research_settings(actor)
        row = self.repo.owned(session_id, actor, active=True)
        if row.get("mode") != "text" or not row["attestation"] or (version is not None and row["contextVersion"] != version):
            raise HTTPException(409, "Confirm the current synthetic/deidentified context for text chat.")
        return row

    async def start(self, session_id, request, actor):
        async with self.live.owner_lock(actor):
            async with self.live.session_lock(session_id):
                row = self.require(session_id, actor, request.context_version)
                name = "research_run" if request.action == "research" else "text_chat"
                args = {"query": request.text}
                image = request.image
                if image is not None:
                    args['imageAttachment'] = image.receipt()
                # A duplicate is a lookup, never a second provider call.
                try:
                    previous = self.repo.tool(session_id, request.idempotency_key)
                except HTTPException as error:
                    if error.status_code != 404: raise
                else:
                    if previous["name"] != name or previous["args"] != args or previous["contextVersion"] != request.context_version:
                        raise HTTPException(409, "This request identity belongs to another turn.")
                    return previous
                if actor.sub in self.owners.values() or len(self.tasks) >= 2:
                    raise HTTPException(409, "Finish or cancel the active text/research task before starting another.")
                config = self.live.config_for(actor)
                try:
                    provider, key, model = config.research_configuration()
                except ValueError:
                    raise HTTPException(503, "The selected text model is unavailable.") from None
                if (provider, model) != (row["providerId"], row["modelId"]):
                    raise HTTPException(409, "The selected model changed. Start a new text conversation.")
                if image is not None:
                    if provider != 'codex':
                        raise HTTPException(409, "Viewer image attachments currently require a ChatGPT / Codex model.")
                    try: image.check_current(row)
                    except ValueError:
                        raise HTTPException(409, "The attached view is no longer current. Remove it and attach the current view again.") from None
                    if not await self.live.codex.supports_images(actor, model):
                        raise HTTPException(409, "The selected subscription model does not advertise image input. Choose an image-capable model in Settings.")
                    self.require(session_id, actor, request.context_version)
                tool, _ = self.repo.add_tool(session_id, request.idempotency_key, name, args, request.context_version, False)
                self.live.audit(row, actor, f"{session_id}:{tool['toolCallId']}")
                self.repo.event(session_id, "transcript", {"role": "user", "text": request.text, "turnId": request.idempotency_key, "finished": True})
                job = (session_id, tool["toolCallId"])
                self.owners[job] = actor.sub
                self.tasks[job] = asyncio.create_task(self.execute(row, tool, actor, provider, key, model, image))
                return tool

    def chat_history(self, session_id, actor):
        history = []
        for tool in reversed(self.repo.history(session_id, actor)["tools"]):
            if tool["name"] != "text_chat" or tool["status"] != "completed": continue
            note = '[Historical view was attached to this earlier turn; its pixels are not supplied now.] ' if tool['args'].get('imageAttachment') else ''
            pair = [{"role": "user", "content": note + tool["args"]["query"]}, {"role": "assistant", "content": tool["result"]["summary"]}]
            if len(history) + 2 > 6 or len(json.dumps(pair + history).encode()) > 5000: break
            history = pair + history
        return history

    async def execute(self, row, tool, actor, provider, key, model, image=None):
        sid, tid, version = row["sessionId"], tool["toolCallId"], row["contextVersion"]
        def check():
            self.require(sid, actor, version)
            if self.repo.tool(sid, tid)["status"] in TERMINAL_TOOLS:
                raise asyncio.CancelledError()
        async def progress(event):
            check()
            if event.get("stage") in RESEARCH_PROGRESS_STAGES:
                self.repo.event(sid, "research_progress", {"toolCallId": tid, "stage": event["stage"]})
        try:
            check()
            self.repo.set_tool(sid, tid, "running")
            self.repo.record_research_generation(sid, tid, provider=provider, model=model)
            await progress({"stage": "queued"})
            metadata = text_context(row["viewerContext"].get("state", {}))
            query = tool["args"]["query"]
            if tool["name"] == "text_chat":
                worker = ChatSupervisor(key, model, provider=provider, context=metadata, history=self.chat_history(sid, actor))
            else:
                worker = ResearchSupervisor(key, model, provider=provider)
                # Research receives only a public question plus neutral modality/counts.
                # Images, clinical identifiers and prior chat prose never enter PubMed.
                query = "Public literature question: " + query + ("\nOne current viewport snapshot is attached; not the full series." if image else "\nNo image pixels were shared.") + " Neutral viewer metadata: " + json.dumps({k: v for k, v in metadata.items() if k in {"modality", "imageCount", "index"}})
            remaining = (parse_iso_z(actor.expires_at) - utc_now()).total_seconds()
            async with asyncio.timeout(max(0.01, min(120, remaining))):
                if provider == "codex":
                    result = await self.live.codex.run(actor, model, query, research=tool["name"] == "research_run",
                        context=metadata if tool["name"] == "text_chat" else None,
                        history=self.chat_history(sid, actor) if tool["name"] == "text_chat" else None, on_progress=progress,
                        **({'image': image} if image else {}))
                else:
                    result = await worker.run(query, on_progress=progress)
            check()
            if tool["name"] == "text_chat" and result.get("error"):
                result["summary"] = "The text request timed out." if result["error"] == "research_timeout" else "The selected text model could not complete this request."
            status = "failed" if result.get("error") else "completed"
            updated = self.repo.set_tool(sid, tid, status, result)
            self.repo.event(sid, "tool", updated)
            if result.get("sources"):
                self.repo.event(sid, "citations", {"sources": result["sources"]})
            if tool["name"] == "text_chat":
                self.repo.event(sid, "transcript", {"role": "assistant", "text": result["summary"], "turnId": tid, "finished": True})
        except asyncio.CancelledError:
            raise
        except Exception:
            # Private provider/storage exceptions do not cross the API boundary.
            try:
                current = self.repo.tool(sid, tid)
                if current["status"] not in TERMINAL_TOOLS:
                    updated = self.repo.set_tool(sid, tid, "failed", {"error": "text_failed", "summary": "The selected model could not complete this request. No alternate model was used."})
                    self.repo.event(sid, "tool", updated)
            except Exception:
                pass
        finally:
            self.tasks.pop((sid, tid), None)
            self.owners.pop((sid, tid), None)

    async def cancel(self, session_id, tool_id, actor=None, *, status="cancelled"):
        if actor is not None:
            self.live.require_actor(actor)
            self.repo.owned(session_id, actor)
        tool = self.repo.tool(session_id, tool_id)
        if tool["status"] in TERMINAL_TOOLS: return tool
        task = self.tasks.get((session_id, tool_id))
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        # A task cancelled before its first instruction cannot run its finally block.
        self.tasks.pop((session_id, tool_id), None)
        self.owners.pop((session_id, tool_id), None)
        updated = self.repo.set_tool(session_id, tool_id, status)
        self.repo.event(session_id, "tool", updated)
        return updated

    async def stop(self, session_id, *, status="cancelled"):
        for sid, tid in list(self.tasks):
            if sid == session_id:
                await self.cancel(sid, tid, status=status)

    async def shutdown(self):
        for sid in {sid for sid, _ in self.tasks}:
            await self.stop(sid, status="interrupted")
