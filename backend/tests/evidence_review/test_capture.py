import asyncio
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx
import pytest

from backend.clinical.ai_research_worker import MODEL, ResearchTools


def install_pubmed_fixture(monkeypatch, abstract="Synthetic evidence."):
    def handler(request):
        if request.url.path.endswith("esearch.fcgi"):
            return httpx.Response(200, json={"esearchresult": {"idlist": ["123"]}})
        return httpx.Response(200, content=(f'<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article><ArticleTitle>Synthetic</ArticleTitle><Abstract><AbstractText Label="RESULTS">{abstract}</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>').encode())
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))


def test_capture_callback_cannot_change_tool_result(monkeypatch):
    def broken(source, article):
        source["id"] = "s99"
        article.clear()
        raise RuntimeError("private-marker")
    install_pubmed_fixture(monkeypatch)
    plain = ResearchTools(None, MODEL, lambda event: None)
    captured = ResearchTools(None, MODEL, lambda event: None, on_pubmed=broken)
    assert asyncio.run(plain.search_pubmed("synthetic")) == asyncio.run(captured.search_pubmed("synthetic"))


@pytest.mark.parametrize("length,status", [(0,"absent"),(10000,"complete"),(10001,"truncated")])
def test_collector_preserves_completeness_and_tool_return(monkeypatch, length, status):
    from backend.evidence_review.capture_worker import EvidenceCollector
    install_pubmed_fixture(monkeypatch, "x" * length)
    collector = EvidenceCollector()
    plain = ResearchTools(None, MODEL, lambda event: None)
    captured = ResearchTools(None, MODEL, lambda event: None, on_pubmed=collector)
    result = asyncio.run(captured.search_pubmed("synthetic"))
    assert result == asyncio.run(plain.search_pubmed("synthetic"))
    evidence = collector.records["s1"]
    assert evidence["completeness"] == status
    assert evidence["original_chars"] == length
    assert sum(len(s["text"]) for s in evidence["sections"]) == min(length,10000)


def test_same_pmid_changed_text_is_unavailable(monkeypatch):
    from backend.evidence_review.capture_worker import EvidenceCollector
    c = EvidenceCollector()
    source = {"id":"s1","url":"https://pubmed.ncbi.nlm.nih.gov/123/","title":"Synthetic"}
    for content in ("alpha", "alpha", "beta"):
        c(source, ET.fromstring(f'<PubmedArticle><MedlineCitation><PMID>123</PMID><AbstractText>{content}</AbstractText></MedlineCitation></PubmedArticle>'))
    assert len(c.records) == 1
    assert c.records["s1"]["completeness"] == "unavailable"
    assert c.exclusions[-1]["reason"] == "source_changed_during_capture"


def test_capture_failure_preserves_valid_answer():
    from backend.evidence_review.capture import assemble_capture
    result = {"summary":"Synthetic [s1].", "sources":[{"id":"s1","title":"Paper","url":"https://pubmed.ncbi.nlm.nih.gov/123/"}],"limitations":[],"usage":{}}
    capture = assemble_capture(result, [], [], MODEL)
    assert capture.result.summary == result["summary"]
    assert capture.evidence[0].completeness == "unavailable"
    assert capture.capture_exclusions[0].reason == "capture_unavailable"


def test_no_key_isolated_capture_exits_without_payload():
    from backend.evidence_review import capture_worker
    from backend.clinical.ai_research import _child_environment
    request = {"query":"private-marker", "model":MODEL,"data_class":"synthetic"}
    result = subprocess.run([sys.executable,"-I",capture_worker.__file__],input=json.dumps(request),
                            text=True,capture_output=True,env=_child_environment(""),timeout=10)
    assert result.returncode == 1
    assert result.stdout == ""
    assert "private-marker" not in result.stderr


def test_real_graph_capture_on_off_preserves_answer_and_model_inputs(monkeypatch):
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_google_genai import ChatGoogleGenerativeAI
    from backend.clinical.ai_research_worker import run_worker
    from backend.evidence_review.capture_worker import EvidenceCollector
    install_pubmed_fixture(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "synthetic-key")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    inputs = []
    async def generate(self, messages, **kwargs):
        inputs.append([(m.type, m.content) for m in messages])
        call = ({"name":"search_pubmed","args":{"query":"synthetic"},"id":"search","type":"tool_call"}
                if len(inputs) == 1 else
                {"name":"ResearchAnswer","args":{"summary":"Synthetic evidence [s1].","source_ids":["s1"],"limitations":[]},"id":"answer","type":"tool_call"})
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="",tool_calls=[call]))])
    monkeypatch.setattr(ChatGoogleGenerativeAI,"_agenerate",generate)
    outputs, recorded = [], []
    collector = EvidenceCollector()
    for callback in (None, collector):
        inputs.clear()
        outputs.append(asyncio.run(run_worker({"query":"synthetic","model":MODEL},lambda e:None,on_pubmed=callback)))
        recorded.append(list(inputs))
    assert outputs[0] == outputs[1]
    assert recorded[0] == recorded[1]
    assert collector.records["s1"]["sections"][0]["text"] == "Synthetic evidence."


def test_capture_holds_process_slot_through_cleanup(monkeypatch):
    from backend.evidence_review import capture as module
    from backend.evidence_review.contracts import Limits
    from backend.tests.test_ai_research import FakeProcess, RESULT
    async def scenario():
        started, release, cleaning = [], asyncio.Event(), asyncio.Event()
        async def spawn(*args, **kwargs):
            assert "RADSYSX_TYPESAFE_AI_API_KEY" not in kwargs["env"]
            process = FakeProcess([{"kind":"result","result":RESULT}])
            started.append(process)
            return process
        async def cleanup(process):
            cleaning.set()
            await release.wait()
        monkeypatch.setattr(module.asyncio,"create_subprocess_exec",spawn)
        monkeypatch.setattr(module,"_stop_process",cleanup)
        async def call():
            return await module.capture_public_query("synthetic",api_key="synthetic",data_class="synthetic",limits=Limits())
        tasks = [asyncio.create_task(call())]
        await cleaning.wait()
        tasks.extend(asyncio.create_task(call()) for _ in range(2))
        for _ in range(10):
            await asyncio.sleep(0)
        try:
            assert len(started) == 2
        finally:
            release.set()
            await asyncio.gather(*tasks)
    asyncio.run(scenario())
