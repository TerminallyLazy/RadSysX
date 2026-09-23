import asyncio
from copy import deepcopy
import json

import httpx
from pydantic import SecretStr
import pytest


def response():
    return {"model":"jev-1.13.0","answers":{"relationship":{"type":"choice","choice":"supported",
        "probabilities":{"supported":1.0,"partially_supported":0.0,"contradicted":0.0,"mixed":0.0,"not_addressed":0.0},"confidence":1.0}},
        "usage":{"input_tokens":230,"output_tokens":12}}


def run_adapter(snapshot_factory, handler, key="synthetic-secret"):
    from backend.evidence_review.contracts import Limits
    from backend.evidence_review.units import build_review_plan
    from backend.evidence_review.typesafe import TypeSafeAdapter
    pair=build_review_plan(snapshot_factory(),limits=Limits()).pairs[0]
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler),follow_redirects=False,trust_env=False) as client:
            adapter=TypeSafeAdapter(SecretStr(key),client)
            return await adapter.attempt(adapter.prepare(pair))
    return asyncio.run(scenario())


def test_exact_wire_request_and_valid_judgment(snapshot_factory):
    def handler(request):
        assert str(request.url)=="https://api.typesafe.ai/v1/systemone"
        assert request.headers['authorization']=="Bearer synthetic-secret"
        assert b'synthetic-secret' not in request.content
        assert json.loads(request.content)["state"]["claim"]=="Synthetic evidence [s1]."
        return httpx.Response(200,json=response())
    outcome=run_adapter(snapshot_factory,handler)
    assert outcome.judgment.label=="supported" and outcome.usage["input_tokens"]==230


@pytest.mark.parametrize("mutate",[
    lambda p:p.update(model="jev-other"),
    lambda p:p['answers'].update(extra={}),
    lambda p:p['answers']['relationship'].update(type="noul"),
    lambda p:p['answers']['relationship'].update(choice="invented"),
    lambda p:p['answers']['relationship']['probabilities'].pop('mixed'),
    lambda p:p['answers']['relationship']['probabilities'].update(mixed=0.5),
    lambda p:p['answers']['relationship'].update(choice="mixed"),
    lambda p:p['answers']['relationship'].update(confidence=2),
    lambda p:p['answers']['relationship'].update(confidence=True),
    lambda p:p['usage'].update(input_tokens=True),
    lambda p:p['usage'].update(output_tokens=-1),
])
def test_malformed_success_never_becomes_judgment(snapshot_factory,mutate):
    data=response(); mutate(data)
    outcome=run_adapter(snapshot_factory,lambda req:httpx.Response(200,json=data))
    assert outcome.judgment is None and not outcome.retryable


@pytest.mark.parametrize("status,reason,retry,stop",[
    (401,"credential_rejected",False,True),(403,"credential_rejected",False,True),
    (404,"model_unavailable",False,True),(422,"invalid_request",False,False),
    (429,"overloaded",True,False),(529,"overloaded",True,False),
    (500,"overloaded",True,False),(502,"overloaded",True,False),(503,"overloaded",True,False),(504,"overloaded",True,False),
    (400,"provider_rejected",False,False),(501,"provider_rejected",False,False),
    (302,"unexpected_redirect",False,False),
])
def test_fixed_statuses_do_not_leak_error_body(snapshot_factory,status,reason,retry,stop,capsys):
    outcome=run_adapter(snapshot_factory,lambda req:httpx.Response(status,text="private-provider-body synthetic-secret",headers={"Retry-After":"3","Location":"https://evil.example/"}))
    assert (outcome.reason,outcome.retryable,outcome.stop_evaluator)==(reason,retry,stop)
    assert "private-provider-body" not in outcome.model_dump_json()+str(capsys.readouterr())
    assert "synthetic-secret" not in outcome.model_dump_json()


def test_missing_key_prevents_request(snapshot_factory):
    outcome=run_adapter(snapshot_factory,lambda req:pytest.fail("network dispatched"),key="")
    assert outcome.reason=="missing_credential" and not outcome.submitted
