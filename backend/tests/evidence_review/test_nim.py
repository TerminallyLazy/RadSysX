import asyncio
import json

import httpx
from pydantic import SecretStr
import pytest

from backend.evidence_review.contracts import Limits
from backend.evidence_review.units import build_review_plan

MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b'


def response():
    return {'model':MODEL,'choices':[{'finish_reason':'stop','message':{'role':'assistant','content':'{"label":"supported"}','reasoning_content':'private reasoning'}}],
            'usage':{'prompt_tokens':20,'completion_tokens':8,'total_tokens':28,'completion_tokens_details':{'reasoning_tokens':4}}}


@pytest.mark.parametrize('mutation,reason', [('valid',None),('model','model_mismatch'),('incomplete','nim_incomplete'),
    ('tool','invalid_response'),('label','invalid_response'),('usage','invalid_response'),('oversize','invalid_response'),('refusal','nim_incomplete')])
def test_nim_single_turn_validation(snapshot_factory,mutation,reason):
    from backend.evidence_review.nim import NIMAdapter
    payload=response()
    if mutation=='model': payload['model']='other/model'
    if mutation=='incomplete': payload['choices'][0]['finish_reason']='length'
    if mutation=='tool': payload['choices'][0]['message']['tool_calls']=[{}]
    if mutation=='label': payload['choices'][0]['message']['content']='{"label":"supported","confidence":1}'
    if mutation=='usage': payload['usage']['prompt_tokens']=True
    if mutation=='oversize': payload['extra']='x'*131072
    if mutation=='refusal': payload['choices'][0]['message']['refusal']='No'
    async def scenario():
        def handler(request):
            body=json.loads(request.content)
            assert str(request.url)=='https://integrate.api.nvidia.com/v1/chat/completions'
            assert request.headers['authorization']=='Bearer synthetic-nim'
            assert body['model']==MODEL and body['stream'] is False and len(body['messages'])==2
            assert 'tools' not in body and 'synthetic-nim' not in request.content.decode()
            return httpx.Response(200,json=payload)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            adapter=NIMAdapter(SecretStr('synthetic-nim'),client,model=MODEL)
            pair=build_review_plan(snapshot_factory(),limits=Limits()).pairs[0]
            result=await adapter.attempt(adapter.prepare(pair))
            assert result.reason==reason
            assert 'private reasoning' not in result.model_dump_json()
            if mutation=='valid':
                assert result.judgment.probabilities is None
                assert result.usage['reasoning_tokens']==4
    asyncio.run(scenario())


@pytest.mark.parametrize('status,body,expected',[(200,{'data':[{'id':MODEL},{'id':MODEL},{'id':'openai/gpt-oss-20b'}]},None),
    (302,{},'unexpected_redirect'),(401,{},'credential_rejected'),(200,{'data':[{'id':'https://evil.test'}]},'invalid_response'),
    (200,{'data':[], 'extra':'x'*1048576},'invalid_response')])
def test_catalog_is_bounded_fixed_origin_and_not_capability_proof(status,body,expected):
    from backend.evidence_review.nim import discover_models
    async def scenario():
        def handler(request):
            assert str(request.url)=='https://integrate.api.nvidia.com/v1/models' and request.method=='GET'
            assert request.headers['authorization']=='Bearer synthetic-nim'
            return httpx.Response(status,json=body,headers={'location':'https://evil.test'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result=await discover_models(SecretStr('synthetic-nim'),client)
            assert result.get('error')==expected
            if expected is None:
                assert result['models']==[MODEL,'openai/gpt-oss-20b']
                assert result['capabilities_verified'] is False
    asyncio.run(scenario())


def test_nim_requires_explicit_model():
    from backend.evidence_review.nim import NIMAdapter
    with pytest.raises(ValueError): NIMAdapter(SecretStr('synthetic'),None,model='')


def test_cli_nim_replay_resume_and_catalog(snapshot_factory,tmp_path,capsys):
    from backend.evidence_review.cli import CLIServices, main
    from backend.evidence_review.settings import load_settings
    from backend.tests.evidence_review.test_cli import private_json
    calls=[]
    def handler(request):
        calls.append(request.method)
        return httpx.Response(200,json={'data':[{'id':MODEL}]} if request.method=='GET' else response())
    services=CLIServices(settings_loader=lambda **kw:load_settings(environ={'RADSYSX_NVIDIA_API_KEY':'synthetic-nim'},env_file=None),
        client_factory=lambda:httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    path=private_json(tmp_path/'input'/'snapshot.json',snapshot_factory().model_dump(mode='json'))
    assert main(['models','--provider','nvidia_nim'],services=services)==0
    assert json.loads(capsys.readouterr().out)['models']==[MODEL]
    assert main(['replay','--snapshot',str(path),'--evaluator','nvidia_nim','--model',MODEL,
                 '--output-root',str(tmp_path/'runs')],services=services)==0
    run=json.loads(capsys.readouterr().out)['run']
    assert main(['resume','--run',run],services=services)==0
    capsys.readouterr()
    assert calls==['GET','POST']


def test_catalog_clinical_gate_precedes_keys(monkeypatch,capsys):
    from backend.evidence_review import cli
    monkeypatch.setenv('RADSYSX_APP_MODE','clinical')
    monkeypatch.setattr(cli,'load_settings',lambda **kw:pytest.fail('key read'))
    assert cli.main(['models','--provider','nvidia_nim'])==2
    assert 'evaluation_disabled' in capsys.readouterr().out


def test_catalog_cancel_before_dispatch(tmp_path,capsys):
    from backend.evidence_review.cli import CLIServices,main
    from backend.evidence_review.settings import load_settings
    services=CLIServices(settings_loader=lambda **kw:load_settings(environ={'RADSYSX_NVIDIA_API_KEY':'synthetic'},env_file=None),
        client_factory=lambda:httpx.AsyncClient(transport=httpx.MockTransport(lambda request:pytest.fail('cancelled catalog dispatched'))))
    services.cancel.set()
    assert main(['models','--provider','nvidia_nim'],services=services)==130


def test_glm_uses_explicit_low_reasoning_and_clears_thinking(snapshot_factory):
    from backend.evidence_review.nim import NIMAdapter
    adapter=NIMAdapter(SecretStr('synthetic'),None,model='z-ai/glm-5.3-flash')
    body=json.loads(adapter.prepare(build_review_plan(snapshot_factory(),limits=Limits()).pairs[0]).body)
    assert body['reasoning_effort']=='low'
    assert body['chat_template_kwargs']=={'clear_thinking':True}
    assert adapter.config['reasoning_effort']=='low'
