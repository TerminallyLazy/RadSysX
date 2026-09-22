"""Separate capture protocol; never enlarges the live research protocol."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
import re
import sys

from backend.clinical.ai_research import _child_environment, _slots, _stop_process
from backend.clinical.ai_research_worker import MODEL, normalize_result
from .contracts import CaptureResult, Evidence, Limits, ResearchResult
from .serialization import canonical_json, parse_json, sha256_bytes


def assemble_capture(result: dict, records: list[dict], exclusions: list[dict], model: str) -> CaptureResult:
    typed = ResearchResult.model_validate_json(canonical_json(result))
    collected = {}
    safe_exclusions = []
    for item in records[:20]:
        try:
            evidence = Evidence.model_validate_json(canonical_json(item))
            if evidence.citation_id in collected:
                collected.pop(evidence.citation_id, None)
                safe_exclusions.append({"citation_id":evidence.citation_id,"reason":"duplicate_capture"})
            else:
                collected[evidence.citation_id] = evidence
        except (ValueError, TypeError):
            continue
    for item in exclusions[:20]:
        if isinstance(item, dict) and item.get("reason") in {"source_changed_during_capture", "capture_metadata_limit"}:
            safe_exclusions.append({"citation_id":item.get("citation_id"), "reason":item["reason"]})
    evidence = []
    for source in typed.sources:
        match = re.fullmatch(r"https://pubmed\.ncbi\.nlm\.nih\.gov/([0-9]{1,12})/", source.url)
        if not match:
            safe_exclusions.append({"citation_id":source.id,"reason":"non_pubmed_source"})
            continue
        item = collected.get(source.id)
        if item is None or item.url != source.url:
            item = Evidence(evidence_id="e-" + sha256_bytes(source.url.encode())[:24], citation_id=source.id,
                source_kind="pubmed_abstract", pmid=match[1], url=source.url, title=source.title,
                retrieved_at=datetime.now(timezone.utc), sections=(), extraction_version="ncbi-abstract-v1",
                text_sha256=sha256_bytes(b"[]"), completeness="unavailable", original_chars=None)
            safe_exclusions.append({"citation_id":source.id,"reason":"capture_unavailable"})
        evidence.append(item.model_dump(mode="json"))
    return CaptureResult.model_validate_json(canonical_json({"result":result,"evidence":evidence,
        "capture_exclusions":safe_exclusions[:40], "generation":{"model":model,"origin":"research_worker",
        "temperature":1.0,"thinking_level":"medium","prompt_version":"research-worker-43d443ff",
        "max_output_tokens":4000}}))


async def capture_public_query(query: str, *, api_key: str, data_class: str, limits: Limits) -> CaptureResult:
    if not api_key or data_class not in {"public_literature","synthetic"} or not isinstance(query,str) or not 1 <= len(query.strip()) <= 2000:
        raise ValueError("capture_configuration")
    try:
        async with asyncio.timeout(120):
            async with _slots():
                return await _capture_child(query, api_key=api_key, data_class=data_class, limits=limits)
    except asyncio.CancelledError:
        raise
    except (ValueError, TypeError, KeyError, TimeoutError, OSError):
        raise ValueError("capture_failed") from None


async def _capture_child(query: str, *, api_key: str, data_class: str, limits: Limits) -> CaptureResult:
    process = None
    try:
        spawn = asyncio.create_task(asyncio.create_subprocess_exec(sys.executable,"-I","-u",
            str(Path(__file__).with_name("capture_worker.py")), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,
            env=_child_environment(api_key),limit=128*1024))
        try:
            process = await asyncio.shield(spawn)
        except asyncio.CancelledError:
            process = await spawn
            raise
        process.stdin.write(canonical_json({"query":query,"model":MODEL,"data_class":data_class})+b"\n")
        await process.stdin.drain()
        process.stdin.close()
        result, records, exclusions, size = None, [], [], 0
        while line := await process.stdout.readline():
            size += len(line)
            if size > limits.snapshot_bytes:
                raise ValueError("capture_limit")
            event = parse_json(line,max_bytes=128*1024)
            kind = event.get("kind")
            if kind == "result" and result is None:
                result = normalize_result(event.get("result"))
            elif kind == "evidence" and len(records) < 20:
                records.append(event.get("evidence"))
            elif kind == "capture_summary" and isinstance(event.get("exclusions"),list):
                exclusions = event["exclusions"][:20]
            elif kind != "progress":
                raise ValueError("capture_protocol")
        code = await process.wait()
        if result is None:
            raise ValueError("capture_failed")
        if code != 0:
            records, exclusions = [], []
        return assemble_capture(result,records,exclusions,MODEL)
    finally:
        if process is not None:
            cleanup = asyncio.create_task(_stop_process(process))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                await cleanup
                raise
