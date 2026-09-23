"""Single-turn Gemini baseline sharing the exact claim, evidence and rubric."""
import re
import time

import httpx
from pydantic import SecretStr, TypeAdapter

from .contracts import AttemptOutcome, Judgment, PreparedRequest, ReviewPair, TokenCount
from .rubric import INSTRUCTIONS, RELATIONSHIP_CRITERIA, RUBRIC_SHA256, RUBRIC_VERSION, pair_state
from .serialization import canonical_json, parse_json, sha256_bytes
from .transport import post_bounded, status_outcome

MODEL = "gemini-3.8-flash"
BASELINE_CONFIG = {
    "temperature":1.0, "maxOutputTokens":4000,
    "thinkingConfig":{"thinkingLevel":"MEDIUM","includeThoughts":False},
    "responseMimeType":"application/json",
    "responseJsonSchema":{"type":"object","properties":{"label":{"type":"string","enum":list(RELATIONSHIP_CRITERIA)}},
                          "required":["label"],"additionalProperties":False},
}


def prepare_gemini(pair: ReviewPair, *, config: dict) -> PreparedRequest:
    if (set(config) != set(BASELINE_CONFIG) or config["responseMimeType"] != "application/json"
            or config["responseJsonSchema"] != BASELINE_CONFIG["responseJsonSchema"]
            or type(config["temperature"]) not in (int,float) or not 0 <= config["temperature"] <= 2
            or type(config["maxOutputTokens"]) is not int or not 1 <= config["maxOutputTokens"] <= 4000
            or config["thinkingConfig"] not in [{"thinkingLevel":level,"includeThoughts":False} for level in ("LOW","MEDIUM","HIGH")]):
        raise ValueError("invalid_baseline_config")
    body = canonical_json({"contents":[{"role":"user","parts":[{"text":canonical_json(pair_state(pair)).decode()}]}],
        "systemInstruction":{"parts":[{"text":canonical_json({"instructions":INSTRUCTIONS,"criteria":RELATIONSHIP_CRITERIA}).decode()}]},
        "generationConfig":config})
    if len(body) > 131072:
        raise ValueError("request_too_large")
    return PreparedRequest("gemini",MODEL,RUBRIC_VERSION,RUBRIC_SHA256,sha256_bytes(body),body)


class GeminiAdapter:
    evaluator_id = "gemini"
    model = MODEL

    def __init__(self, key: SecretStr, client: httpx.AsyncClient, *, config: dict | None = None,
                 expected_resolved_model: str | None = None):
        self._key, self._client = key, client
        self.config = parse_json(canonical_json(BASELINE_CONFIG if config is None else config))
        self.expected_resolved_model = expected_resolved_model

    def prepare(self, pair):
        return prepare_gemini(pair,config=self.config)

    async def attempt(self, request):
        if not self._key.get_secret_value():
            return AttemptOutcome(reason="missing_credential",stop_evaluator=True)
        if request.model != self.model or request.evaluator != self.evaluator_id or sha256_bytes(request.body) != request.request_sha256:
            return AttemptOutcome(reason="request_mismatch",stop_evaluator=True)
        started = time.monotonic()
        usage = None
        def failed(reason):
            return AttemptOutcome(reason=reason,submitted=True,usage=usage,elapsed_seconds=time.monotonic()-started)
        try:
            receipt = await post_bounded(self._client,
                url=f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
                headers={"x-goog-api-key":self._key.get_secret_value()},body=request.body,byte_limit=131072)
            failure = status_outcome(receipt)
            if failure:
                return failure
            payload = parse_json(receipt.body,max_bytes=131072)
            if not isinstance(payload,dict):
                raise ValueError("invalid_response")
            metadata = payload.get("usageMetadata")
            if metadata is not None:
                if not isinstance(metadata,dict):
                    raise ValueError("invalid_usage")
                usage = TypeAdapter(dict[str,TokenCount]).validate_python({k:v for k,v in metadata.items() if k in
                    {"promptTokenCount","candidatesTokenCount","thoughtsTokenCount","totalTokenCount","cachedContentTokenCount","toolUsePromptTokenCount"}},strict=True)
                if not usage:
                    usage = None
            if payload.get("promptFeedback",{}).get("blockReason"):
                return failed("gemini_blocked")
            resolved = payload.get("modelVersion")
            if (not isinstance(resolved,str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,160}",resolved)
                    or not (resolved == MODEL or resolved.startswith(MODEL + "-"))
                    or self.expected_resolved_model and resolved != self.expected_resolved_model):
                return failed("model_mismatch")
            candidates = payload.get("candidates")
            if not isinstance(candidates,list) or len(candidates) != 1:
                raise ValueError("invalid_candidate")
            candidate = candidates[0]
            if candidate.get("finishReason") != "STOP":
                return failed("gemini_incomplete")
            parts = candidate["content"]["parts"]
            if not isinstance(parts,list) or not parts:
                raise ValueError("invalid_parts")
            texts = []
            for part in parts:
                if (not isinstance(part,dict) or set(part) - {"text","thought","thoughtSignature"}
                        or not isinstance(part.get("text"),str) or type(part.get("thought",False)) is not bool):
                    raise ValueError("invalid_part")
                if not part.get("thought",False):
                    texts.append(part["text"])
            label = parse_json("".join(texts).encode(),max_bytes=131072)
            if not isinstance(label,dict) or set(label) != {"label"}:
                raise ValueError("invalid_label")
            judgment = Judgment(label=label["label"],requested_model=self.model,resolved_model=resolved)
            return AttemptOutcome(judgment=judgment,submitted=True,usage=usage,elapsed_seconds=time.monotonic()-started)
        except httpx.TimeoutException:
            return AttemptOutcome(reason="timeout",retryable=True,submitted=True,elapsed_seconds=time.monotonic()-started)
        except httpx.RequestError:
            return AttemptOutcome(reason="network_failure",retryable=True,submitted=True,elapsed_seconds=time.monotonic()-started)
        except (ValueError,TypeError,KeyError,AttributeError):
            return failed("invalid_response")
