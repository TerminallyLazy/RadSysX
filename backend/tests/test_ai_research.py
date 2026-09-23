"""Synthetic research-worker checks. No Google calls or patient records."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from backend.clinical import ai_research as supervisor_module
from backend.clinical.ai_research import ResearchSupervisor, _child_environment
from backend.clinical.ai_research_worker import (
    MODEL,
    MAX_TOOL_CALLS,
    ResearchTools,
    SourceLedger,
    _response_text,
    create_research_agent,
    normalize_result,
    public_url,
    run_worker,
)


RESULT = {
    "summary": "A synthetic finding [s1].",
    "sources": [{"id": "s1", "title": "PubMed source", "url": "https://pubmed.ncbi.nlm.nih.gov/123/"}],
    "limitations": [],
    "usage": {"total_tokens": 20},
}


class FakeStdin:
    def __init__(self):
        self.data = b""

    def write(self, data):
        self.data += data

    async def drain(self):
        await asyncio.sleep(0)

    def close(self):
        pass


class FakeProcess:
    def __init__(self, events=None, *, blocked=False, stubborn=False):
        self.stdin = FakeStdin()
        self.stdout = asyncio.StreamReader()
        self.returncode = None
        self.terminated = False
        self.killed = False
        self.waited = False
        self.stubborn = stubborn
        self.done = asyncio.Event()
        if not blocked:
            for event in events or []:
                self.stdout.feed_data((json.dumps(event) + "\n").encode())
            self.stdout.feed_eof()
            self.done.set()

    def finish(self):
        self.stdout.feed_data((json.dumps({"kind": "result", "result": RESULT}) + "\n").encode())
        self.stdout.feed_eof()
        self.done.set()

    def terminate(self):
        self.terminated = True
        if not self.stubborn:
            self.returncode = -15
            self.done.set()

    def kill(self):
        self.killed = True
        self.returncode = -9
        self.done.set()

    async def wait(self):
        self.waited = True
        await self.done.wait()
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


@pytest.mark.parametrize("url", [
    "http://example.com", "https://localhost/x", "https://host.local/x",
    "https://127.0.0.1/x", "https://10.0.0.1/x", "https://169.254.169.254/x",
    "https://[::1]/x", "https://user:secret@example.com/", "https://example.com:3000/",
    "file:///tmp/test", "https://127.1/", "https://2130706433/", "https://example.com/\nsecret",
])
def test_non_public_citation_urls_are_rejected(url):
    assert public_url(url) is None


def test_source_ledger_deduplicates_validated_sources():
    ledger = SourceLedger()
    source = ledger.add("A paper", "https://pubmed.ncbi.nlm.nih.gov/123/#abstract")
    assert source == ledger.add("Same paper", "https://pubmed.ncbi.nlm.nih.gov/123/")
    assert ledger.add("Private", "https://127.0.0.1/") is None
    assert ledger.get("s999") is None
    assert source["id"] == "s1"


def test_result_contains_only_public_fields_and_valid_citations():
    result = normalize_result({
        **RESULT,
        "summary": "<think>private reasoning</think>Finding [s1], [s99], [fake](https://invented.example/a)",
        "thoughts": "private reasoning",
        "sources": [*RESULT["sources"], {"id": "s2", "title": "Private", "url": "https://localhost/a"}],
        "usage": {"total_tokens": 20, "api_key": "secret", "output_tokens": -1},
    })
    assert result["sources"] == RESULT["sources"]
    assert "private reasoning" not in json.dumps(result)
    assert "s99" not in result["summary"]
    assert "invented.example" not in result["summary"]
    assert result["usage"] == {"total_tokens": 20}


def test_thought_parts_never_become_tool_evidence():
    response = SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[
        SimpleNamespace(text="private reasoning", thought=True),
        SimpleNamespace(text="Public evidence", thought=False),
        SimpleNamespace(inline_data=b"unused"),
    ]))])
    assert _response_text(response) == "Public evidence"


def test_child_environment_excludes_other_credentials_and_tracing(monkeypatch):
    for name in ["OPENAI_API_KEY", "GOOGLE_API_KEY", "LANGSMITH_API_KEY", "PYTHONPATH", "HTTPS_PROXY", "RADSYSX_SESSION_SECRET"]:
        monkeypatch.setenv(name, "owner-secret")
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    environment = _child_environment("synthetic-gemini-key")
    assert "owner-secret" not in environment.values()
    assert environment["GEMINI_API_KEY"] == "synthetic-gemini-key"
    assert environment["LANGSMITH_TRACING"] == "false"
    assert environment["GOOGLE_GENAI_USE_VERTEXAI"] == "false"


def test_supervisor_only_exposes_safe_progress_and_normalized_result(monkeypatch):
    async def scenario():
        progress = []
        process = FakeProcess([
            {"kind": "progress", "stage": "searching_web", "thought": "private"},
            {"kind": "progress", "stage": "private reasoning"},
            {"kind": "result", "result": RESULT},
        ])
        spawn = AsyncMock(return_value=process)
        monkeypatch.setattr(supervisor_module.asyncio, "create_subprocess_exec", spawn)
        result = await ResearchSupervisor("synthetic-key").run("A public synthetic query", progress.append)
        assert result["summary"] == RESULT["summary"]
        assert progress == [{"stage": "searching_web"}]
        assert process.waited and not process.terminated
        args, kwargs = spawn.call_args
        assert "-I" in args and kwargs["stderr"] == asyncio.subprocess.DEVNULL
        assert "shell" not in kwargs
        assert json.loads(process.stdin.data)["model"] == MODEL
    asyncio.run(scenario())


def test_supervisor_failure_does_not_expose_exception_or_worker_payload(monkeypatch):
    async def scenario():
        process = FakeProcess([{"kind": "error", "message": "owner-secret patient payload"}])
        monkeypatch.setattr(supervisor_module.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
        result = await ResearchSupervisor("synthetic-key").run("Synthetic query")
        assert result["error"] == "research_failed"
        assert "owner-secret" not in json.dumps(result)
        assert process.terminated and process.waited
    asyncio.run(scenario())


def test_timeout_terminates_and_reaps_child(monkeypatch):
    async def scenario():
        process = FakeProcess(blocked=True)
        monkeypatch.setattr(supervisor_module.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
        result = await ResearchSupervisor("synthetic-key", timeout_seconds=.02).run("Synthetic query")
        assert result["error"] == "research_timeout"
        assert process.terminated and process.waited
    asyncio.run(scenario())


@pytest.mark.parametrize("events,returncode,expected", [
    ([{"kind": "error", "code": "research_timeout"}], 1, "research_timeout"),
    ([{"kind": "error", "code": "research_timeout"}], 0, "research_failed"),
    ([{"kind": "error", "code": "research_timeout", "message": "private"}], 1, "research_failed"),
    ([{"kind": "result", "result": RESULT}, {"kind": "error", "code": "research_timeout"}], 1, "research_failed"),
    ([{"kind": "error", "code": "research_timeout"}, {"kind": "result", "result": RESULT}], 1, "research_failed"),
])
def test_worker_timeout_protocol_is_fixed_and_terminal(monkeypatch, events, returncode, expected):
    async def scenario():
        process = FakeProcess(events)
        process.returncode = returncode
        monkeypatch.setattr(supervisor_module.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
        result = await ResearchSupervisor("synthetic-key").run("Synthetic query")
        assert result["error"] == expected
        assert "private" not in json.dumps(result)
        assert process.waited
    asyncio.run(scenario())


def test_worker_provider_timeout_emits_no_exception_details(monkeypatch):
    import io
    from backend.clinical import ai_research_worker as worker
    async def timed_out(*args):
        raise TimeoutError("private credential and request")
    output = io.StringIO()
    monkeypatch.setattr(worker, "run_worker", timed_out)
    monkeypatch.setattr(worker.logging, "disable", lambda level: None)
    monkeypatch.setattr(worker.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b'{"query":"synthetic"}\n')))
    monkeypatch.setattr(worker.sys, "stdout", output)
    assert worker.main() == 1
    assert json.loads(output.getvalue()) == {"kind": "error", "code": "research_timeout"}


def test_cancellation_terminates_child_and_propagates(monkeypatch):
    async def scenario():
        process = FakeProcess(blocked=True)
        started = asyncio.Event()
        async def spawn(*args, **kwargs):
            started.set()
            return process
        monkeypatch.setattr(supervisor_module.asyncio, "create_subprocess_exec", spawn)
        task = asyncio.create_task(ResearchSupervisor("synthetic-key").run("Synthetic query"))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert process.terminated and process.waited
    asyncio.run(scenario())


def test_two_concurrent_jobs_across_supervisors_and_canceled_queue(monkeypatch):
    async def scenario():
        processes = []
        two_started = asyncio.Event()
        async def spawn(*args, **kwargs):
            process = FakeProcess(blocked=True)
            processes.append(process)
            if len(processes) == 2:
                two_started.set()
            return process
        monkeypatch.setattr(supervisor_module.asyncio, "create_subprocess_exec", spawn)
        tasks = [asyncio.create_task(ResearchSupervisor("synthetic-key").run("Synthetic query")) for _ in range(3)]
        await two_started.wait()
        await asyncio.sleep(0)
        assert len(processes) == 2
        tasks[2].cancel()
        with pytest.raises(asyncio.CancelledError):
            await tasks[2]
        for process in processes:
            process.finish()
        results = await asyncio.gather(*tasks[:2])
        assert all(result["summary"] for result in results)
        assert len(processes) == 2
    asyncio.run(scenario())


def test_actual_graph_manifest_has_only_research_and_virtual_scratch_tools():
    # Actual installed deepagents/adapter construction, but no model invocation.
    tools = ResearchTools(None, MODEL, lambda event: None)
    _, budget, names = create_research_agent("synthetic-test-key", MODEL, tools)
    assert set(names) == {"search_web", "search_pubmed", "read_source", "write_todos", "ls", "read_file", "write_file", "edit_file", "glob", "grep"}
    assert budget.calls == 0


def test_research_tool_budget_rejects_another_dispatch():
    tools = ResearchTools(None, MODEL, lambda event: None)
    for _ in range(MAX_TOOL_CALLS):
        tools.reserve_tool_call()
    with pytest.raises(RuntimeError):
        tools.reserve_tool_call()
    assert tools.tool_calls == MAX_TOOL_CALLS


@pytest.mark.parametrize("provider", ["gemini", "nvidia_nim"])
@pytest.mark.parametrize("requested", [MAX_TOOL_CALLS, MAX_TOOL_CALLS + 1])
def test_actual_graph_applies_shared_budget_to_parallel_scratch_tools(monkeypatch, requested, provider):
    from deepagents.backends import StateBackend
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_google_genai import ChatGoogleGenerativeAI

    model_calls, dispatched = [], []
    original_list = StateBackend.als

    async def list_scratch(self, path):
        dispatched.append(path)
        return await original_list(self, path)

    async def generate(self, messages, stop=None, run_manager=None, **kwargs):
        model_calls.append(messages)
        calls = ([{"name": "ls", "args": {"path": "/"}, "id": f"scratch-{i}", "type": "tool_call"}
                  for i in range(requested)] if len(model_calls) == 1 else [
            {"name": "ResearchAnswer", "args": {"summary": "Synthetic scratch-only result.",
                "source_ids": [], "limitations": ["Synthetic only."]}, "id": "answer", "type": "tool_call"},
        ])
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=calls))])

    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")
    monkeypatch.setattr(StateBackend, "als", list_scratch)
    from langchain_nvidia_ai_endpoints import ChatNVIDIA
    monkeypatch.setattr(ChatGoogleGenerativeAI if provider == "gemini" else ChatNVIDIA, "_agenerate", generate)
    model = MODEL if provider == "gemini" else "nvidia/nemotron-3-super-120b-a12b"
    tools = ResearchTools(None, model, lambda event: None)
    agent, _, _ = create_research_agent("synthetic-unused-key", model, tools, provider=provider)

    async def scenario():
        invocation = agent.ainvoke({"messages": [{"role": "user", "content": "Synthetic budget check."}]})
        if requested > MAX_TOOL_CALLS:
            with pytest.raises(RuntimeError, match="Research tool limit reached"):
                await invocation
            assert len(dispatched) <= MAX_TOOL_CALLS
        else:
            state = await invocation
            assert state["structured_response"].summary == "Synthetic scratch-only result."
            assert len(dispatched) == MAX_TOOL_CALLS
        assert tools.tool_calls == MAX_TOOL_CALLS

    asyncio.run(scenario())


def test_read_source_requires_known_ledger_reference():
    async def scenario():
        client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=AsyncMock())))
        tools = ResearchTools(client, MODEL, lambda event: None)
        result = await tools.read_source("https://127.0.0.1/private")
        assert "error" in result
        client.aio.models.generate_content.assert_not_called()
    asyncio.run(scenario())


def test_read_source_requires_successful_provider_retrieval():
    async def scenario():
        client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=AsyncMock(return_value=SimpleNamespace(candidates=[])))))
        tools = ResearchTools(client, MODEL, lambda event: None)
        tools.ledger.add("Paper", "https://pubmed.ncbi.nlm.nih.gov/123/")
        assert "error" in await tools.read_source("s1")
    asyncio.run(scenario())


def test_pubmed_uses_fixed_endpoints_and_registers_actual_pmids(monkeypatch):
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.path.endswith("esearch.fcgi"):
            return httpx.Response(200, json={"esearchresult": {"idlist": ["123"], 'count':'42', 'querytranslation':'synthetic imaging[Title/Abstract]'}})
        return httpx.Response(200, content=b"<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article><ArticleTitle>Synthetic evidence</ArticleTitle><Journal><Title>Synthetic journal</Title><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal><Abstract><AbstractText Label='RESULTS'>Public synthetic abstract.</AbstractText></Abstract><PublicationTypeList><PublicationType>Review</PublicationType></PublicationTypeList></Article><MeshHeadingList><MeshHeading><DescriptorName>Diagnostic Imaging</DescriptorName></MeshHeading></MeshHeadingList></MedlineCitation></PubmedArticle></PubmedArticleSet>")
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    tools = ResearchTools(None, MODEL, lambda event: None)
    result = asyncio.run(tools.search_pubmed("synthetic imaging", limit=999))
    assert result["articles"][0]["pmid"] == "123"
    assert result["sources"][0]["url"] == "https://pubmed.ncbi.nlm.nih.gov/123/"
    assert all(request.url.host == "eutils.ncbi.nlm.nih.gov" for request in requests)
    assert requests[0].url.params["retmax"] == "10"
    article=result['articles'][0]
    assert article['abstract']=='Public synthetic abstract.'
    assert article['abstractSections']==[{'label':'RESULTS','start':0,'end':len(article['abstract'])}]
    assert article['publicationTypes']==['Review'] and article['meshTerms']==['Diagnostic Imaging']
    assert article['journal']=='Synthetic journal'
    assert result['search']['totalMatches']==42 and result['search']['returnedPmids']==['123']
    assert tools.pubmed_searches[0]['translatedQuery']=='synthetic imaging[Title/Abstract]'


def test_real_graph_tool_turn_and_structured_result_without_network(monkeypatch):
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_google_genai import ChatGoogleGenerativeAI

    calls = []
    async def generate(self, messages, stop=None, run_manager=None, **kwargs):
        calls.append(kwargs)
        call = (
            {"name": "search_pubmed", "args": {"query": "synthetic evidence"}, "id": "search-1", "type": "tool_call"}
            if len(calls) == 1 else
            {"name": "ResearchAnswer", "args": {"summary": "Synthetic evidence [s1].", "source_ids": ["s1", "invented"], "limitations": ["Synthetic test only."]}, "id": "answer-1", "type": "tool_call"}
        )
        return ChatResult(generations=[ChatGeneration(message=AIMessage(
            content="", tool_calls=[call],
            usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        ))])

    async def pubmed(self, query: str, limit: int = 5) -> dict:
        """Search synthetic PubMed evidence for this test."""
        self._begin("searching_pubmed")
        source = self.ledger.add("Synthetic paper", "https://pubmed.ncbi.nlm.nih.gov/123/")
        return {"sources": [source], "articles": [{"sourceId": "s1", "abstract": "Synthetic evidence"}]}

    monkeypatch.setenv("GEMINI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    pubmed.__name__ = "search_pubmed"
    monkeypatch.setattr(ChatGoogleGenerativeAI, "_agenerate", generate)
    monkeypatch.setattr(ResearchTools, "search_pubmed", pubmed)
    events = []
    result = asyncio.run(run_worker({"query": "A public synthetic query", "model": MODEL}, events.append))
    assert result["summary"] == "Synthetic evidence [s1]."
    assert [source["id"] for source in result["sources"]] == ["s1"]
    assert result["usage"] == {"input_tokens": 20, "output_tokens": 10, "total_tokens": 30, "model_calls": 2, "tool_calls": 1}
    assert events == [
        {"kind": "progress", "stage": "starting"},
        {"kind": "progress", "stage": "waiting_model"},
        {"kind": "progress", "stage": "searching_pubmed"},
        {"kind": "progress", "stage": "waiting_model"},
        {"kind": "progress", "stage": "synthesizing"},
    ]
    assert len(calls) == 2


def test_worker_process_without_key_exits_privately():
    worker = Path(supervisor_module.__file__).with_name("ai_research_worker.py")
    environment = _child_environment("")
    result = subprocess.run(
        [sys.executable, "-I", str(worker)],
        input=json.dumps({"query": "synthetic private failure marker", "model": MODEL}) + "\n",
        text=True, capture_output=True, env=environment, timeout=10,
    )
    assert result.returncode == 1
    assert not result.stdout
    assert "synthetic private failure marker" not in result.stderr


def test_nim_environment_and_supervisor_use_only_selected_credential(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY','must-not-inherit')
    monkeypatch.setenv('RADSYSX_OPENAI_API_KEY','must-not-inherit')
    env=_child_environment('synthetic-nim',provider='nvidia_nim')
    assert env['NVIDIA_API_KEY']=='synthetic-nim' and 'GEMINI_API_KEY' not in env
    async def scenario():
        process=FakeProcess([{'kind':'result','result':RESULT}])
        spawn=AsyncMock(return_value=process)
        monkeypatch.setattr(supervisor_module.asyncio,'create_subprocess_exec',spawn)
        result=await ResearchSupervisor('synthetic-nim',model='nvidia/nemotron-3-super-120b-a12b',provider='nvidia_nim').run('Synthetic query')
        assert result['summary']==RESULT['summary']
        assert spawn.call_args.kwargs['env']['NVIDIA_API_KEY']=='synthetic-nim'
        assert 'GEMINI_API_KEY' not in spawn.call_args.kwargs['env']
        assert json.loads(process.stdin.data)['provider']=='nvidia_nim'
    asyncio.run(scenario())


@pytest.mark.parametrize("nim_model", ["nvidia/nemotron-3-super-120b-a12b", "z-ai/glm-5.3-flash"])
def test_nim_real_graph_pubmed_and_structured_result(monkeypatch, nim_model):
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration,ChatResult
    from langchain_nvidia_ai_endpoints import ChatNVIDIA
    calls=[]
    async def generate(self,messages,stop=None,run_manager=None,**kwargs):
        calls.append(kwargs)
        assert self._async_client.timeout == 60
        if nim_model == 'z-ai/glm-5.3-flash':
            assert self.model_kwargs == {'reasoning_effort':'low','chat_template_kwargs':{'clear_thinking':True}}
        names={t['function']['name'] for t in kwargs['tools']}
        assert 'search_pubmed' in names
        assert not names & {'search_web','read_source','execute','eval','task','task_async','launch_async_task'}
        call=({'name':'search_pubmed','args':{'query':'synthetic evidence'},'id':'search-1','type':'tool_call'} if len(calls)==1 else
              {'name':'ResearchAnswer','args':{'summary':'Synthetic evidence [s1].','source_ids':['s1','fake'],'limitations':[]},'id':'answer-1','type':'tool_call'})
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content='',tool_calls=[call],
            usage_metadata={'input_tokens':10,'output_tokens':5,'total_tokens':15}))])
    async def pubmed(self,query: str,limit: int=5)->dict:
        """Search synthetic PubMed literature."""
        self._begin('searching_pubmed')
        return {'sources':[self.ledger.add('Synthetic paper','https://pubmed.ncbi.nlm.nih.gov/123/')],'articles':[]}
    pubmed.__name__='search_pubmed'
    monkeypatch.setenv('NVIDIA_API_KEY','synthetic-nim')
    monkeypatch.delenv('GEMINI_API_KEY',raising=False)
    monkeypatch.setenv('LANGSMITH_TRACING','false')
    from langchain_nvidia_ai_endpoints._common import _NVIDIASyncClient
    from langchain_nvidia_ai_endpoints._statics import Model as NIMModel
    monkeypatch.setattr(_NVIDIASyncClient,'available_models',property(lambda self:[NIMModel(id=nim_model)]))
    monkeypatch.setattr(ChatNVIDIA,'_agenerate',generate)
    monkeypatch.setattr(ResearchTools,'search_pubmed',pubmed)
    result=asyncio.run(run_worker({'query':'Synthetic public query','provider':'nvidia_nim','model':nim_model},lambda event:None))
    assert result['summary']=='Synthetic evidence [s1].'
    assert len(result['sources'])==1 and result['usage']['model_calls']==2 and result['usage']['tool_calls']==1


def test_research_settings_select_provider_and_never_fall_back(monkeypatch):
    from backend.clinical.ai_config import AISettings
    monkeypatch.setattr(Path,'is_file',lambda self:False)
    monkeypatch.setenv('RADSYSX_GEMINI_API_KEY','synthetic-google')
    monkeypatch.setenv('RADSYSX_NVIDIA_API_KEY','synthetic-nvidia')
    monkeypatch.delenv('RADSYSX_RESEARCH_PROVIDER',raising=False)
    assert AISettings().research_configuration()==('gemini','synthetic-google',MODEL)
    monkeypatch.setenv('RADSYSX_RESEARCH_PROVIDER','nvidia_nim')
    monkeypatch.setenv('RADSYSX_NIM_RESEARCH_MODEL','nvidia/nemotron-3-super-120b-a12b')
    config=AISettings()
    assert config.research_configuration()==('nvidia_nim','synthetic-nvidia','nvidia/nemotron-3-super-120b-a12b')
    config.api_key='owner-google'
    assert config.research_configuration()[1]=='synthetic-nvidia'
    config.nvidia_api_key=''
    with pytest.raises(ValueError): config.research_configuration()
    monkeypatch.setenv('RADSYSX_RESEARCH_PROVIDER','typo')
    with pytest.raises(ValueError): AISettings().research_configuration()
    with pytest.raises(ValueError): AISettings(app_mode='clinical').research_configuration()
