"""Synthetic, network-isolated evidence-review fixtures."""
import socket
from copy import deepcopy

import pytest


@pytest.fixture(autouse=True)
def no_live_secrets_or_network(monkeypatch):
    for name in ("RADSYSX_TYPESAFE_AI_API_KEY", "RADSYSX_GEMINI_API_KEY", "RADSYSX_NVIDIA_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    original = socket.socket.connect
    def connect(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            raise AssertionError("Live network is forbidden in evidence tests")
        return original(sock, address)
    monkeypatch.setattr(socket.socket, "connect", connect)


@pytest.fixture
def payload_factory():
    def make(*, answer="Synthetic evidence [s1].", abstract="Synthetic evidence.",
             completeness="complete", evidence_count=1, data_class="synthetic"):
        sources, evidence = [], []
        for i in range(1, evidence_count + 1):
            url = f"https://example.com/paper/{i}"
            sources.append({"id": f"s{i}", "title": "Synthetic paper", "url": url})
            evidence.append({"evidence_id": f"e{i}", "citation_id": f"s{i}",
                "source_kind": "synthetic", "pmid": None, "url": url, "title": "Synthetic paper",
                "retrieved_at": "2026-09-22T00:00:00Z", "sections": [{"label": None, "text": abstract}],
                "extraction_version": "fixture-v1", "completeness": completeness, "original_chars": len(abstract)})
        return deepcopy({"snapshot_id": "synthetic-snapshot", "created_at": "2026-09-22T00:00:00Z",
            "data_class": data_class, "generation": {"origin": "fixture"},
            "result": {"summary": answer, "sources": sources, "limitations": [], "usage": {}},
            "evidence": evidence, "capture_exclusions": []})
    return make


@pytest.fixture
def snapshot_factory(payload_factory):
    def make(**kwargs):
        from backend.evidence_review.contracts import Limits, freeze_snapshot
        return freeze_snapshot(payload_factory(**kwargs), limits=Limits())
    return make
