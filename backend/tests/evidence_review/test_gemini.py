import asyncio
from copy import deepcopy
import json

import httpx
from pydantic import SecretStr
import pytest

from backend.evidence_review.contracts import Limits
from backend.evidence_review.rubric import prepare_jev, RELATIONSHIP_CRITERIA
from backend.evidence_review.units import build_review_plan


def response():
    return {'modelVersion':'gemini-3.8-flash','candidates':[{'finishReason':'STOP','content':{'role':'model','parts':[{'text':'{"label":"supported"}'}]}}],
            'usageMetadata':{'promptTokenCount':10,'candidatesTokenCount':4,'thoughtsTokenCount':20,'totalTokenCount':34}}


def test_same_evidence_fresh_context(snapshot_factory):
    from backend.evidence_review.gemini import prepare_gemini, BASELINE_CONFIG
    pair=build_review_plan(snapshot_factory(),limits=Limits()).pairs[0]
    jev=json.loads(prepare_jev(pair).body); gemini=json.loads(prepare_gemini(pair,config=BASELINE_CONFIG).body)
    assert json.loads(gemini['contents'][0]['parts'][0]['text'])==jev['state']
    assert set(gemini)=={'contents','systemInstruction','generationConfig'}
    assert json.loads(gemini['systemInstruction']['parts'][0]['text'])['criteria']==RELATIONSHIP_CRITERIA
    assert len(gemini['contents'])==1


@pytest.mark.parametrize('mutation,reason',[
    ('valid',None),('blocked','gemini_blocked'),('empty','invalid_response'),('refused','gemini_incomplete'),
    ('thought','invalid_response'),('tool','invalid_response'),('bad_label','invalid_response'),
    ('drift','model_mismatch'),('bool_usage','invalid_response'),('oversize','invalid_response'),
])
def test_response_validation(snapshot_factory,mutation,reason):
    from backend.evidence_review.gemini import GeminiAdapter
    payload=response()
    if mutation=='blocked': payload['promptFeedback']={'blockReason':'SAFETY'}
    if mutation=='empty': payload['candidates']=[]
    if mutation=='refused': payload['candidates'][0]['finishReason']='SAFETY'
    if mutation=='thought': payload['candidates'][0]['content']['parts'][0]['thought']=True
    if mutation=='tool': payload['candidates'][0]['content']['parts'].append({'functionCall':{'name':'unsafe'}})
    if mutation=='bad_label': payload['candidates'][0]['content']['parts'][0]['text']='{"label":"supported","confidence":1}'
    if mutation=='drift': payload['modelVersion']='gemini-another'
    if mutation=='bool_usage': payload['usageMetadata']['thoughtsTokenCount']=True
    if mutation=='oversize': payload['extra']='x'*131072
    async def scenario():
        def handler(request):
            assert request.url==httpx.URL('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
            assert request.headers['x-goog-api-key']=='test-secret'
            assert 'test-secret' not in request.content.decode()
            return httpx.Response(200,json=payload)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            adapter=GeminiAdapter(SecretStr('test-secret'),client,expected_resolved_model='gemini-3.8-flash')
            outcome=await adapter.attempt(adapter.prepare(build_review_plan(snapshot_factory(),limits=Limits()).pairs[0]))
            assert outcome.reason==reason
            if mutation=='valid':
                assert outcome.judgment.probabilities is None and outcome.judgment.confidence is None
                assert outcome.usage['thoughtsTokenCount']==20
    asyncio.run(scenario())
