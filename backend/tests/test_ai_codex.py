"""Subscription contracts with synthetic protocol frames; never real account auth."""
import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock
import pytest
from fastapi.testclient import TestClient
from backend.tests.test_ai_live import live, authorize, PREFIX, ORIGIN
from backend.tests.test_ai_text import session_request, turn
from backend.clinical.ai_codex import CodexProcess, CONFIG, auth_url, private_directory


@pytest.fixture
def anyio_backend(): return 'asyncio'


class FakeCodex(CodexProcess):
    def __init__(self, home):
        super().__init__(home)
        self.calls = []
        self.frames = []
        self.signed_in = False
        self.block = False
        self.started = asyncio.Event()
        self.closed = False
    async def start(self): pass
    async def close(self): self.closed = True; self.account = None
    async def send(self, message): self.frames.append(message)
    async def call(self, method, params=None):
        self.calls.append((method, params))
        if method == 'account/read': return {'account': {'type':'chatgpt', 'email':'synthetic@example.invalid', 'planType':'pro'} if self.signed_in else None}
        if method == 'account/login/start': return {'loginId':'synthetic-login', 'authUrl':'https://auth.openai.com/authorize?state=synthetic'}
        if method == 'account/logout': self.signed_in = False; return {}
        if method == 'model/list': return {'data':[{'model':'synthetic-codex-model'}], 'nextCursor': None}
        if method == 'thread/start': return {'model':params['model'], 'modelProvider':'openai', 'instructionSources':[], 'sandbox':{'type':'readOnly','networkAccess':False}, 'thread':{'id':'thread-synthetic'}}
        if method == 'turn/start':
            self.started.set()
            if not self.block:
                if self.job['research']:
                    async def search(query, limit):
                        source = self.job['tools'].ledger.add('Synthetic evidence', 'https://pubmed.ncbi.nlm.nih.gov/123/')
                        return {'articles':[], 'sources':[source]}
                    self.job['tools'].search_pubmed = search
                    await self.dispatch({'id':'tool-1', 'method':'item/tool/call', 'params':{'threadId':'thread-synthetic', 'tool':'search_pubmed', 'arguments':{'query':'synthetic public literature', 'limit':3}}})
                self.job['answer'] = 'Synthetic response [s1].'
                self.job['status'] = 'completed'
                self.job['done'].set()
            return {'turn':{'id':'turn-synthetic'}}
        return {}


def configured(live):
    live.service.config.codex_enabled = True
    live.service.codex.factory = FakeCodex
    return live.service.codex


@pytest.mark.anyio
async def test_owned_signin_catalog_select_chat_research_receipts_and_logout(live):
    service = configured(live)
    assert not (await service.status(live.actor))['signedIn']
    assert not service.ready(live.actor.sub)
    login = await service.login(live.actor)
    assert login['authUrl'].startswith('https://auth.openai.com/')
    client = service.clients[live.actor.sub]
    assert str(client.home).endswith(__import__('hashlib').sha256(live.actor.sub.encode()).hexdigest())
    client.signed_in = True; client.login_id = None; client.login_state = 'completed'
    await service.status(live.actor)
    assert service.ready(live.actor.sub)
    result = await live.service.change_research_settings(live.actor, 'codex', 'synthetic-codex-model')
    assert result['providerId'] == 'codex'
    row = await live.service.text.create(session_request(), live.actor)
    assert row['mode'] == 'text' and row['liveUrl'] is None and row['providerId'] == 'codex'
    for action in ['chat','research']:
        await live.service.text.start(row['sessionId'], turn(action, action=action, text='A synthetic public question.'), live.actor)
        await asyncio.gather(*list(live.service.text.tasks.values()))
        receipt = live.service.repository.tool(row['sessionId'], action)
        assert receipt['status'] == 'completed'
        assert receipt['research']['providerId'] == 'codex'
        assert bool(receipt['result']['sources']) == (action == 'research')
    starts = [p for m,p in client.calls if m == 'thread/start']
    assert all(p['environments'] == [] and p['ephemeral'] and p['approvalPolicy'] == 'never' for p in starts)
    assert starts[0]['dynamicTools'] == []
    assert [t['name'] for t in starts[1]['dynamicTools']] == ['search_pubmed']
    assert starts[1]['dynamicTools'][0]['type'] == 'function'
    assert 'apiKey' not in json.dumps(client.calls)
    await service.signout(live.actor)
    assert not service.ready(live.actor.sub)
    assert live.service.repository.owned(row['sessionId'], live.actor)['status'] == 'closed'
    await service.shutdown()


@pytest.mark.anyio
async def test_cancel_running_and_unknown_ack_stops_process(live):
    service = configured(live)
    client = await service.client(live.actor); client.signed_in = True; client.block = True
    task = asyncio.create_task(service.run(live.actor, 'synthetic-codex-model', 'Synthetic question', research=False, on_progress=AsyncMock()))
    await client.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert client.closed and live.actor.sub not in service.clients
    assert any(m == 'turn/interrupt' for m,_ in client.calls)
    client = await service.client(live.actor); client.signed_in = True
    original = client.call
    async def unacknowledged(method, params=None):
        if method == 'turn/start': client.started.set(); await asyncio.Future()
        return await original(method, params)
    client.call = unacknowledged
    task = asyncio.create_task(service.run(live.actor, 'synthetic-codex-model', 'Synthetic question', research=False, on_progress=AsyncMock()))
    await client.started.wait(); task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert client.closed
    client = await service.client(live.actor); client.signed_in = True
    original_thread = client.call
    async def unacknowledged_thread(method, params=None):
        if method == 'thread/start': client.started.set(); await asyncio.Future()
        return await original_thread(method, params)
    client.call = unacknowledged_thread
    task = asyncio.create_task(service.run(live.actor, 'synthetic-codex-model', 'Synthetic question', research=False, on_progress=AsyncMock()))
    await client.started.wait(); task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert client.closed and live.actor.sub not in service.clients
    await service.shutdown()


@pytest.mark.anyio
async def test_tool_dispatch_rejects_other_threads_names_parameters_and_limits(tmp_path):
    client = FakeCodex(tmp_path)
    tools = type('Tools', (), {'search_pubmed': AsyncMock(return_value={'sources': []})})()
    client.job = {'thread':'owned', 'research':True, 'check':lambda:None, 'tools':tools, 'calls':0, 'progress':AsyncMock()}
    for tool, thread, args in [('shell','owned',{}), ('search_pubmed','other',{'query':'x'}), ('search_pubmed','owned',{'query':'x','path':'/secret'}), ('search_pubmed','owned',{'query':'x','limit':True})]:
        await client.dispatch({'id':1,'method':'item/tool/call','params':{'threadId':thread,'tool':tool,'arguments':args}})
        assert 'error' in client.frames[-1]
    assert tools.search_pubmed.await_count == 0
    client.job['calls'] = 8
    await client.dispatch({'id':2,'method':'item/tool/call','params':{'threadId':'owned','tool':'search_pubmed','arguments':{'query':'public'}}})
    assert tools.search_pubmed.await_count == 0


def test_http_private_errors_origin_auth_mode_and_strict_input(live):
    service = configured(live)
    with TestClient(live.app) as client:
        response = client.get(PREFIX+'/codex/account')
        assert response.status_code == 401 and response.headers['cache-control'] == 'no-store'
        authorize(client, live)
        assert client.get(PREFIX+'/codex/account').json()['signedIn'] is False
        assert client.post(PREFIX+'/codex/login',json={}).status_code == 403
        for body in ['{"apiKey":"PRIVATE"}', '{"x":1,"x":2}', '{"x":NaN}']:
            response = client.post(PREFIX+'/codex/login',content=body,headers={'Origin':ORIGIN,'Content-Type':'application/json'})
            assert response.status_code == 422 and 'PRIVATE' not in response.text
        service.clients[live.actor.sub].call = AsyncMock(side_effect=RuntimeError('PRIVATE OAuth token'))
        response = client.get(PREFIX+'/codex/account')
        assert response.status_code == 503 and 'PRIVATE' not in response.text
        live.service.config.app_mode = 'clinical'
        assert client.get(PREFIX+'/codex/account').status_code == 403


def test_private_directory_and_official_auth_url(tmp_path):
    root = private_directory(tmp_path/'private')
    linked = tmp_path/'link'; linked.symlink_to(root)
    with pytest.raises(ValueError): private_directory(linked)
    root.chmod(0o755)
    with pytest.raises(ValueError): private_directory(root)
    for url in ['https://auth.openai.com.evil.invalid/', 'http://auth.openai.com/', 'https://x@auth.openai.com/', 'https://auth.openai.com:9999/', 'file:///secret']:
        with pytest.raises(ValueError): auth_url(url)
    assert CONFIG['cli_auth_credentials_store'] == 'keyring'
    assert CONFIG['forced_login_method'] == 'chatgpt'
    assert CONFIG['features.skip_host_skill_discovery']
    assert not CONFIG['features.shell_tool'] and not CONFIG['features.plugins']
    assert CONFIG['features.code_mode_host'] and not CONFIG['features.code_mode']


@pytest.mark.anyio
async def test_stdio_reader_uses_final_messages_not_private_reasoning(tmp_path):
    client = CodexProcess(tmp_path)
    stream = asyncio.StreamReader()
    client.process = type('Process', (), {'stdout':stream})()
    client.job = {'thread':'owned','answer':'','done':asyncio.Event()}
    for method, params in [('item/reasoning/textDelta',{'threadId':'owned','delta':'PRIVATE'}),
        ('item/completed',{'threadId':'other','item':{'type':'agentMessage','text':'OTHER'}}),
        ('item/completed',{'threadId':'owned','item':{'type':'agentMessage','phase':'commentary','text':'COMMENTARY'}}),
        ('item/completed',{'threadId':'owned','item':{'type':'agentMessage','phase':'final_answer','text':'PUBLIC'}}),
        ('turn/completed',{'threadId':'owned','turn':{'status':'completed'}})]:
        stream.feed_data(json.dumps({'method':method,'params':params}).encode()+b'\n')
    stream.feed_eof(); await client.read()
    assert client.job['answer'] == 'PUBLIC' and client.job['status'] == 'completed'


@pytest.mark.anyio
async def test_other_account_is_untouched_and_model_drift_fails_before_sending(live):
    service = configured(live)
    other = live.actor.model_copy(update={'sub':'other-synthetic-account'})
    first, second = await service.client(live.actor), await service.client(other)
    assert first.home != second.home
    first.signed_in = second.signed_in = True
    await service.status(live.actor); await service.status(other)
    await service.signout(live.actor)
    assert service.ready(other.sub) and not second.closed
    original = second.call
    async def drift(method, params=None):
        value = await original(method, params)
        if method == 'thread/start': value['model'] = 'unselected-model'
        return value
    second.call = drift
    with pytest.raises(RuntimeError):
        await service.run(other, 'synthetic-codex-model', 'synthetic question', research=False, on_progress=AsyncMock())
    assert not any(m == 'turn/start' for m,_ in second.calls)
    assert second.closed
    await service.shutdown()
