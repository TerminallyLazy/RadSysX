"""Pinned Jev adapter: one pair, one question, one attempt."""
import time

import httpx
from pydantic import SecretStr, TypeAdapter

from .contracts import AttemptOutcome, Judgment, PreparedRequest, ReviewPair, TokenCount
from .rubric import prepare_jev
from .serialization import canonical_json, parse_json, sha256_bytes
from .transport import post_bounded, status_outcome


class TypeSafeAdapter:
    evaluator_id = "jev"
    model = "jev-1.13.0"

    def __init__(self, key: SecretStr, client: httpx.AsyncClient):
        self._key, self._client = key, client

    def prepare(self, pair: ReviewPair) -> PreparedRequest:
        return prepare_jev(pair,model=self.model)

    async def attempt(self, request: PreparedRequest) -> AttemptOutcome:
        if not self._key.get_secret_value():
            return AttemptOutcome(reason="missing_credential",stop_evaluator=True)
        if request.model != self.model or request.evaluator != self.evaluator_id or sha256_bytes(request.body) != request.request_sha256:
            return AttemptOutcome(reason="request_mismatch",stop_evaluator=True)
        started = time.monotonic()
        usage = None
        try:
            receipt = await post_bounded(self._client,url="https://api.typesafe.ai/v1/systemone",
                headers={"Authorization":"Bearer " + self._key.get_secret_value()},body=request.body,byte_limit=131072)
            failure = status_outcome(receipt)
            if failure is not None:
                return failure
            payload = parse_json(receipt.body,max_bytes=131072)
            if not isinstance(payload,dict) or set(payload) != {"model","answers","usage"}:
                raise ValueError("invalid_response")
            if payload["model"] != self.model:
                return AttemptOutcome(reason="model_mismatch",submitted=True,elapsed_seconds=time.monotonic()-started)
            if not isinstance(payload["usage"],dict) or set(payload["usage"]) != {"input_tokens","output_tokens"}:
                raise ValueError("invalid_usage")
            usage = TypeAdapter(dict[str,TokenCount]).validate_python(payload["usage"],strict=True)
            if not isinstance(payload["answers"],dict) or set(payload["answers"]) != {"relationship"}:
                raise ValueError("invalid_answers")
            answer = payload["answers"]["relationship"]
            if not isinstance(answer,dict) or set(answer) != {"type","choice","probabilities","confidence"} or answer["type"] != "choice":
                raise ValueError("invalid_answer")
            judgment = Judgment.model_validate_json(canonical_json({"label":answer["choice"],
                "requested_model":self.model,"resolved_model":payload["model"],
                "probabilities":answer["probabilities"],"confidence":answer["confidence"]}))
            return AttemptOutcome(judgment=judgment,submitted=True,usage=usage,elapsed_seconds=time.monotonic()-started)
        except httpx.TimeoutException:
            return AttemptOutcome(reason="timeout",retryable=True,submitted=True,elapsed_seconds=time.monotonic()-started)
        except httpx.RequestError:
            return AttemptOutcome(reason="network_failure",retryable=True,submitted=True,elapsed_seconds=time.monotonic()-started)
        except (ValueError, TypeError, KeyError):
            return AttemptOutcome(reason="invalid_response",submitted=True,usage=usage,elapsed_seconds=time.monotonic()-started)
