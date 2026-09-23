"""Standalone isolated capture entrypoint; stdlib only before research loading."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import runpy
import sys
from datetime import datetime, timezone


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


class EvidenceCollector:
    def __init__(self):
        self.records = {}
        self.exclusions = []

    def __call__(self, source, article):
        if source["id"] not in self.records and len(self.records) >= 20:
            return
        source_id = source["id"]
        nodes = article.findall(".//AbstractText")
        original = sum(len("".join(node.itertext())) for node in nodes)
        valid_metadata = len(nodes) <= 64 and all(len(node.get("Label", "")) <= 256 for node in nodes)
        sections, remaining = [], 10000
        if valid_metadata:
            for node in nodes:
                text = "".join(node.itertext())[:remaining]
                sections.append({"schema_version": 1, "label": node.get("Label"), "text": text})
                remaining -= len(text)
        status = ("unavailable" if not valid_metadata else "absent" if not original else
                  "truncated" if original > 10000 else "complete")
        record = {"schema_version":1, "evidence_id":"e-" + hashlib.sha256(source["url"].encode()).hexdigest()[:24],
            "citation_id":source_id, "source_kind":"pubmed_abstract", "pmid":article.findtext(".//MedlineCitation/PMID", ""),
            "url":source["url"], "title":source["title"], "retrieved_at":datetime.now(timezone.utc).isoformat(),
            "sections":sections, "extraction_version":"ncbi-abstract-v1", "original_chars":original,
            "text_sha256":hashlib.sha256(_json(sections)).hexdigest(), "completeness":status}
        old = self.records.get(source_id)
        if old:
            if old["text_sha256"] != record["text_sha256"] or old["original_chars"] != original:
                old["completeness"] = "unavailable"
                if not any(e["citation_id"] == source_id for e in self.exclusions):
                    self.exclusions.append({"citation_id":source_id,"reason":"source_changed_during_capture"})
            return
        self.records[source_id] = record
        if not valid_metadata:
            self.exclusions.append({"citation_id":source_id,"reason":"capture_metadata_limit"})


def main():
    logging.disable(logging.CRITICAL)
    protocol = sys.stdout.buffer
    def emit(event):
        raw = _json(event) + b"\n"
        if len(raw) > 128 * 1024:
            raise ValueError("capture_frame_limit")
        protocol.write(raw)
        protocol.flush()
    try:
        raw = sys.stdin.buffer.readline(16385)
        if len(raw) > 16384 or not os.environ.get("GEMINI_API_KEY"):
            return 1
        request = json.loads(raw)
        if not isinstance(request, dict) or set(request) != {"query","model","data_class"} or request["data_class"] not in {"public_literature","synthetic"}:
            return 1
        collector = EvidenceCollector()
        path = Path(__file__).resolve().parents[1] / "clinical" / "ai_research_worker.py"
        with contextlib.redirect_stdout(sys.stderr):
            worker = runpy.run_path(str(path))
            result = asyncio.run(worker["run_worker"](request, emit, on_pubmed=collector))
        # Emit the valid answer first, then optional evidence.
        emit({"kind":"result", "result":result})
        for record in collector.records.values():
            emit({"kind":"evidence", "evidence":record})
        emit({"kind":"capture_summary", "exclusions":collector.exclusions})
        return 0
    except BaseException:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
