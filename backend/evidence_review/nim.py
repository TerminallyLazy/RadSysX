"""Explicit NVIDIA hosted catalog and single-turn evidence evaluator."""
import asyncio
import re
import time

import httpx
from pydantic import SecretStr, TypeAdapter

from .contracts import AttemptOutcome, Judgment, PreparedRequest, TokenCount
from .rubric import INSTRUCTIONS, RELATIONSHIP_CRITERIA, RUBRIC_SHA256, RUBRIC_VERSION, pair_state
from .serialization import canonical_json, parse_json, sha256_bytes
from .transport import HTTPReceipt, post_bounded, status_outcome

BASE_URL = 'https://integrate.api.nvidia.com/v1'
MODEL_PATTERN = r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}/[A-Za-z0-9][A-Za-z0-9._-]{0,159}'
BASELINE_CONFIG = {'temperature':0.0,'max_tokens':1024,'response_format':{'type':'json_object'}}


def validate_model(model):
    if not isinstance(model,str) or not re.fullmatch(MODEL_PATTERN,model):
        raise ValueError('invalid_nim_model')
    return model


async def discover_models(key: SecretStr, client: httpx.AsyncClient) -> dict:
    if not key.get_secret_value(): return {'error':'missing_credential'}
    try:
        async with asyncio.timeout(10):
            async with client.stream('GET',BASE_URL+'/models',headers={'Authorization':'Bearer '+key.get_secret_value(),
                    'Accept-Encoding':'identity'},follow_redirects=False,timeout=10) as response:
                failure=status_outcome(HTTPReceipt(response.status_code,b'',None,0.0))
                if failure: return {'error':failure.reason}
                if response.headers.get('content-encoding','identity').lower()!='identity': raise ValueError()
                data=bytearray()
                async for chunk in response.aiter_bytes(chunk_size=16384):
                    if len(data)+len(chunk)>1048576: raise ValueError()
                    data.extend(chunk)
        payload=parse_json(bytes(data),max_bytes=1048576)
        rows=payload['data']
        if not isinstance(rows,list) or len(rows)>5000: raise ValueError()
        models=sorted({validate_model(row['id']) for row in rows})
        return {'provider':'nvidia_nim','models':models,'capabilities_verified':False}
    except (TimeoutError,httpx.TimeoutException): return {'error':'timeout'}
    except httpx.RequestError: return {'error':'network_failure'}
    except (ValueError,TypeError,KeyError,AttributeError): return {'error':'invalid_response'}


class NIMAdapter:
    evaluator_id='nvidia_nim'

    def __init__(self,key: SecretStr,client: httpx.AsyncClient,*,model: str,config=None,expected_resolved_model=None):
        self.model=validate_model(model)
        self._key,self._client=key,client
        defaults = dict(BASELINE_CONFIG)
        if model == 'z-ai/glm-5.3-flash':
            defaults.update({'reasoning_effort':'low','chat_template_kwargs':{'clear_thinking':True}})
        self.config=parse_json(canonical_json(defaults if config is None else config))
        self.expected_resolved_model=expected_resolved_model
        if (set(self.config)!=set(defaults) or self.config['response_format']!={'type':'json_object'}
                or type(self.config['temperature']) not in (int,float) or not 0<=self.config['temperature']<=1
                or type(self.config['max_tokens']) is not int or not 1<=self.config['max_tokens']<=4000):
            raise ValueError('invalid_nim_config')
        if model == 'z-ai/glm-5.3-flash' and (self.config['reasoning_effort'] not in {'low','high','max'}
                or self.config['chat_template_kwargs'] != {'clear_thinking':True}):
            raise ValueError('invalid_nim_config')

    def prepare(self,pair):
        body=canonical_json({'model':self.model,'stream':False,**self.config,'messages':[
            {'role':'system','content':canonical_json({'instructions':INSTRUCTIONS,'criteria':RELATIONSHIP_CRITERIA,
                'output':'Return only a JSON object with exactly one key, label, whose value is one of the criteria keys.'}).decode()},
            {'role':'user','content':canonical_json(pair_state(pair)).decode()}]})
        if len(body)>131072: raise ValueError('request_too_large')
        return PreparedRequest(self.evaluator_id,self.model,RUBRIC_VERSION,RUBRIC_SHA256,sha256_bytes(body),body)

    async def attempt(self,request):
        if not self._key.get_secret_value(): return AttemptOutcome(reason='missing_credential',stop_evaluator=True)
        if request.model!=self.model or request.evaluator!=self.evaluator_id or sha256_bytes(request.body)!=request.request_sha256:
            return AttemptOutcome(reason='request_mismatch',stop_evaluator=True)
        started=time.monotonic(); usage=None
        def failed(reason):
            return AttemptOutcome(reason=reason,submitted=True,usage=usage,elapsed_seconds=time.monotonic()-started)
        try:
            receipt=await post_bounded(self._client,url=BASE_URL+'/chat/completions',
                headers={'Authorization':'Bearer '+self._key.get_secret_value()},body=request.body,byte_limit=131072)
            failure=status_outcome(receipt)
            if failure: return failure
            payload=parse_json(receipt.body,max_bytes=131072)
            metadata=payload.get('usage')
            if metadata is not None:
                if not isinstance(metadata,dict): raise ValueError()
                counts={k:v for k,v in metadata.items() if k in {'prompt_tokens','completion_tokens','total_tokens'}}
                for group,name in [('completion_tokens_details','reasoning_tokens'),('prompt_tokens_details','cached_tokens')]:
                    details=metadata.get(group) or {}
                    if not isinstance(details,dict): raise ValueError()
                    if name in details: counts[name]=details[name]
                usage=TypeAdapter(dict[str,TokenCount]).validate_python(counts,strict=True) or None
            resolved=payload.get('model')
            if resolved!=self.model or self.expected_resolved_model and resolved!=self.expected_resolved_model:
                return failed('model_mismatch')
            choices=payload['choices']
            if not isinstance(choices,list) or len(choices)!=1: raise ValueError()
            choice=choices[0]; message=choice['message']
            if choice.get('finish_reason')!='stop' or message.get('refusal'): return failed('nim_incomplete')
            if message.get('role')!='assistant' or message.get('tool_calls') or message.get('function_call'): raise ValueError()
            label=parse_json(message['content'].encode(),max_bytes=131072)
            if not isinstance(label,dict) or set(label)!={'label'}: raise ValueError()
            return AttemptOutcome(judgment=Judgment(label=label['label'],requested_model=self.model,resolved_model=resolved),
                submitted=True,usage=usage,elapsed_seconds=time.monotonic()-started)
        except httpx.TimeoutException:
            return AttemptOutcome(reason='timeout',retryable=True,submitted=True,elapsed_seconds=time.monotonic()-started)
        except httpx.RequestError:
            return AttemptOutcome(reason='network_failure',retryable=True,submitted=True,elapsed_seconds=time.monotonic()-started)
        except (ValueError,TypeError,KeyError,AttributeError): return failed('invalid_response')
