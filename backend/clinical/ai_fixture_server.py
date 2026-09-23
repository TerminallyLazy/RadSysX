"""Synthetic desktop-smoke entrypoint. Never selected by normal app startup."""
from __future__ import annotations

import asyncio
import os
import json
from contextlib import asynccontextmanager

if os.environ.get("RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN") != "1":
    raise RuntimeError("Synthetic Live server is available only to desktop smoke tests.")

from google.genai import types
from backend.server import app, ai_live_service
from backend.clinical import ai_research, ai_text


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

    def __init__(self, *args, **kwargs):
        pass

    async def run(self, query, on_progress=None):
        type(self).active += 1
        type(self).peak = max(type(self).peak, type(self).active)
        try:
            number = "one" if "one" in query else "two"
            if on_progress:
                await on_progress({"stage": "waiting_model"})
                await on_progress({"stage": "searching_pubmed"})
            await asyncio.sleep(1.2 if number == "one" else 1.8)
            if os.environ.get('RADSYSX_DESKTOP_EVIDENCE_FIXTURE')=='1':
                summary = 'The synthetic study reports 10 samples [s1]. EXCLUDED_SENTINEL [s1].' if number=='one' else 'The second synthetic study reports 20 samples [s1].'
                return {'summary':summary,'sources':[{'id':'s1','title':'Synthetic review fixture, not a real paper','url':'https://pubmed.ncbi.nlm.nih.gov/123/'}],
                    'limitations':['Synthetic fixture; no web research was performed.']}
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
ai_text.ResearchSupervisor = FixtureResearchSupervisor

class FixtureChatSupervisor:
    def __init__(self, *args, **kwargs): pass
    async def run(self, query, on_progress=None):
        if on_progress: await on_progress({"stage": "waiting_model"})
        await asyncio.sleep(0.4)
        return {"summary": "Synthetic text reply without a Realtime connection. No image pixels were shared.", "sources": []}

ai_text.ChatSupervisor = FixtureChatSupervisor


if os.environ.get('RADSYSX_DESKTOP_EVIDENCE_FIXTURE')=='1':
    import httpx
    from backend.clinical import ai_evidence_review
    from backend.evidence_review import nim
    _evidence = {'submitted':0,'excludedSubmitted':False}

    async def evidence_http(request):
        if request.url.host=='eutils.ncbi.nlm.nih.gov':
            return httpx.Response(200,content=b'<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article><Abstract><AbstractText>The synthetic study reports 10 samples.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>')
        if request.url.host!='api.typesafe.ai': raise AssertionError('Unexpected synthetic destination')
        _evidence['submitted']+=1
        _evidence['excludedSubmitted'] |= b'EXCLUDED_SENTINEL' in request.content
        if _evidence['submitted']>1: await asyncio.Event().wait()
        await asyncio.sleep(1.5)
        return httpx.Response(200,json={'model':'jev-1.13.0','answers':{'relationship':{'type':'choice','choice':'supported',
            'probabilities':{'supported':1.0,'partially_supported':0.0,'contradicted':0.0,'mixed':0.0,'not_addressed':0.0},'confidence':1.0}},
            'usage':{'input_tokens':10,'output_tokens':1}})

    ai_evidence_review.new_http_client=lambda:httpx.AsyncClient(transport=httpx.MockTransport(evidence_http))

    async def fixture_catalog(*args,**kwargs):
        return {'provider':'nvidia_nim','models':['z-ai/glm-5.3-flash']+[f'synthetic/model-{index:03d}' for index in range(81)],'capabilities_verified':False}
    nim.discover_models=fixture_catalog

    @app.get('/api/ai/_fixture/evidence',include_in_schema=False)
    async def fixture_evidence_counters():
        root=ai_live_service.evidence_reviews.root
        return {**_evidence,'privateRuns':sum(p.is_dir() for p in root.iterdir()) if root.exists() else 0}

if os.environ.get('RADSYSX_DESKTOP_VISION_FIXTURE') == '1':
    from .ai_codex import CodexProcess
    from .ai_view_image import jpeg_dimensions
    import base64
    _vision = {'images': 0, 'turns': 0, 'studyImages':0, 'studyActions':0}

    class FixtureCodex(CodexProcess):
        async def start(self): pass
        async def send(self, message):
            self.reply=message
            result=message.get('result',{})
            items=result.get('contentItems',[])
            _vision['studyImages']+=sum(i.get('type')=='inputImage' for i in items)
            if self.job and self.job.get('bridge') and result.get('success'):
                params=self.last_params
                self.notification('item/completed',{'threadId':params['threadId'],'turnId':params['turnId'],
                    'item':{'type':'dynamicToolCall','id':params['callId'],'tool':params['tool'],'namespace':None,'arguments':params['arguments'],'status':'completed','success':True}})
        async def study_call(self,name,args):
            count=getattr(self,'study_count',0)+1;self.study_count=count
            params={'threadId':'synthetic-thread','turnId':'synthetic-turn','callId':f'call-{count}','namespace':None,'tool':name,'arguments':args}
            self.last_params=params
            await self.dispatch({'id':count,'method':'item/tool/call','params':params})
            if 'error' in self.reply or not self.reply['result']['success']: raise RuntimeError('Synthetic study operation failed: '+name)
            # Bridge acknowledgment discards image items. Read its safe receipt instead.
            record=self.job['bridge'].records.get(params['callId'])
            return record['receipt'] if record else json.loads(self.reply['result']['contentItems'][0]['text'])
        async def study_run(self):
            bridge=self.job['bridge'];grant=bridge.check().snapshot.grant
            await self.study_call('viewer_get_capabilities',{})
            for series_id in grant.scope.series_ids:
                page=await self.study_call('series_get_manifest',{'seriesId':series_id})
                for offset in range(0,len(page['frames']),8):
                    await self.study_call('series_read_frames',{'manifestId':page['manifestId'],'frameIds':[f['id'] for f in page['frames'][offset:offset+8]]})
            if 'mutate' in grant.permissions:
                await self.study_call('viewer_jump_to_slice',{'index':31})
                await self.study_call('viewer_set_window_level',{'windowWidth':800,'windowCenter':80})
                _vision['studyActions']+=2
            await self.study_call('viewer_observe',{'kind':'workspace'})
        async def call(self, method, params=None):
            if method == 'account/read': return {'account': {'type': 'chatgpt', 'email': 'synthetic@example.invalid', 'planType': 'pro'}}
            if method == 'model/list': return {'data': [{'model': 'synthetic-vision', 'inputModalities': ['text', 'image']}], 'nextCursor': None}
            if method == 'thread/start': return {'model': params['model'], 'modelProvider': 'openai', 'instructionSources': [], 'sandbox': {'type': 'readOnly', 'networkAccess': False}, 'thread': {'id': 'synthetic-thread'}}
            if method == 'turn/start':
                self.bind_turn('synthetic-turn')
                if self.job.get('bridge'): await self.study_run()
                _vision['turns'] += 1
                for item in params['input']:
                    if item['type'] == 'image':
                        assert item['url'].startswith('data:image/jpeg;base64,')
                        width, height = jpeg_dimensions(base64.b64decode(item['url'].split(',', 1)[1], validate=True))
                        assert 0 < width <= 768 and 0 < height <= 768
                        _vision['images'] += 1
                if self.job['research']:
                    self.job['calls'] = 1
                    self.job['tools'].ledger.add('Synthetic evidence only', 'https://pubmed.ncbi.nlm.nih.gov/123/')
                    await self.job['progress']({'stage': 'searching_pubmed'})
                self.job['answer'] = 'Synthetic image transport verified.' + (' [s1]' if self.job['research'] else '')
                self.job['status'] = 'completed'
                self.job['done'].set()
                return {'turn': {'id': 'synthetic-turn'}}
            return {}

    ai_live_service.config.codex_enabled = True
    ai_live_service.codex.factory = FixtureCodex

    @app.get('/api/ai/_fixture/vision', include_in_schema=False)
    async def fixture_vision_counters(): return _vision
