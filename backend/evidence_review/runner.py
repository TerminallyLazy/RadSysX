"""Bounded offline evaluations with durable attempts and explicit resume."""
import asyncio
from collections import deque
from datetime import datetime, timezone
import random
from typing import Protocol
import uuid

from .artifacts import ArtifactStore, RunView
from .contracts import (Assessment, AttemptOutcome, AttemptRecord, Limits, PreparedRequest,
                        ReviewPair, ReviewPlan, RunResult, Snapshot, SpanAnnotation, load_snapshot)
from .serialization import canonical_json, sha256_bytes
from .units import build_review_plan


class Evaluator(Protocol):
    evaluator_id: str
    model: str
    def prepare(self, pair: ReviewPair) -> PreparedRequest: ...
    async def attempt(self, request: PreparedRequest) -> AttemptOutcome: ...


class LocalStorageFailure(ValueError):
    def __init__(self):
        super().__init__("local_storage_failure")


def resume_key(snapshot_sha256: str, pair: ReviewPair, request: PreparedRequest) -> str:
    return sha256_bytes(canonical_json({"snapshot": snapshot_sha256,
        "unit": pair.unit.model_dump(mode="json"), "evidence": pair.evidence.text_sha256,
        "request": request.request_sha256, "model": request.model, "rubric": request.rubric_sha256,
        "evaluator": request.evaluator}))


def _utc():
    return datetime.now(timezone.utc)


async def evaluate_snapshot(snapshot: Snapshot, plan: ReviewPlan, *, adapter: Evaluator,
                            store: ArtifactStore, limits: Limits, cancel: asyncio.Event,
                            resume: RunView | None = None, experiment_sha256: str | None = None) -> RunResult:
    snapshot = load_snapshot(canonical_json(snapshot.model_dump(mode="json")), limits=limits)
    annotations = tuple(SpanAnnotation(start=u.start,end=u.end,citation_spans=u.citation_spans)
                        for u in plan.units if u.origin == "curated")
    expected = build_review_plan(snapshot,limits=limits,annotations=annotations)
    if expected != plan or (resume and (resume.snapshot is None or resume.snapshot != snapshot)):
        raise ValueError("evaluation_input_mismatch")
    loop = asyncio.get_running_loop()
    started_at = _utc()
    started = loop.time()
    deadline = started + limits.snapshot_seconds
    failure = None
    storage_failed = False
    manifest = {"schema_version":1, "objects":[], "request_refs":[], "attempt_refs":[], "assessment_refs":[], "cache":{}}
    attempts = {a.attempt_id:a for a in resume.attempts} if resume else {}
    assessments = {}
    attempt_refs = {}
    assessment_refs = {}
    requests = {}
    pair_attempts = {}
    pair_started = {}
    cache = resume.manifest.get("cache", {}) if resume else {}
    cached = {a.pair_id:a for a in resume.assessments} if resume else {}

    def put(data, kind):
        nonlocal storage_failed
        try:
            ref = store.put_bytes(data,kind=kind)
            if ref not in manifest["objects"]:
                manifest["objects"].append(ref)
            return ref
        except (OSError, ValueError):
            storage_failed = True
            raise LocalStorageFailure() from None

    def record(value, kind):
        return put(canonical_json(value.model_dump(mode="json")),kind)

    def persist():
        nonlocal storage_failed
        if storage_failed:
            raise LocalStorageFailure()
        manifest["attempt_refs"] = list(attempt_refs.values())
        manifest["assessment_refs"] = list(assessment_refs.values())
        try:
            store.commit_manifest(manifest)
        except (OSError, ValueError):
            storage_failed = True
            raise LocalStorageFailure() from None

    manifest["snapshot_ref"] = record(snapshot,"snapshot")
    manifest["plan_ref"] = record(plan,"plan")
    manifest["evaluator"] = adapter.evaluator_id
    manifest["model"] = adapter.model
    manifest["experiment_sha256"] = experiment_sha256
    manifest["config"] = getattr(adapter,"config",{})
    manifest["limits"] = limits.model_dump(mode="json")
    # Keep prior request bytes and attempts auditable, including interrupted billing.
    if resume:
        for ref in resume.request_refs:
            manifest["request_refs"].append(put(store.read_bytes(ref),"request"))
    for identifier, attempt in attempts.items():
        attempt_refs[identifier] = record(attempt,"attempt")
    for pair in plan.pairs:
        request = adapter.prepare(pair)
        if (request.evaluator != adapter.evaluator_id or request.model != adapter.model
                or sha256_bytes(request.body) != request.request_sha256 or len(request.body) > limits.wire_bytes):
            raise ValueError("invalid_prepared_request")
        requests[pair.pair_id] = request
        ref = put(request.body,"request")
        if ref not in manifest["request_refs"]:
            manifest["request_refs"].append(ref)
        previous = cached.get(pair.pair_id)
        key = resume_key(snapshot.snapshot_sha256,pair,request)
        if (previous is not None and previous.status == "completed" and cache.get(pair.pair_id) == key
                and previous.request_sha256 == request.request_sha256
                and previous.snapshot_sha256 == snapshot.snapshot_sha256
                and previous.evidence_sha256 == pair.evidence.text_sha256
                and previous.model == request.model and previous.evaluator == request.evaluator
                and previous.rubric_sha256 == request.rubric_sha256
                and all(a in attempts for a in previous.attempt_ids)):
            assessments[pair.pair_id] = previous.model_copy(update={"reused_from":store.run_id})
            assessment_refs[pair.pair_id] = record(assessments[pair.pair_id],"assessment")
            manifest["cache"][pair.pair_id] = key
    persist()
    queue = deque(p for p in plan.pairs if p.pair_id not in assessments)
    dispatch = asyncio.Lock()

    def finish(pair, *, outcome=None, reason=None, status=None):
        request = requests[pair.pair_id]
        ids = tuple(pair_attempts.get(pair.pair_id, ()))
        if status is None:
            status = "completed" if outcome and outcome.judgment else "failed"
        assessment = Assessment(pair_id=pair.pair_id,snapshot_sha256=snapshot.snapshot_sha256,
            unit_id=pair.unit.unit_id,evidence_id=pair.evidence.evidence_id,evidence_sha256=pair.evidence.text_sha256,
            evaluator=adapter.evaluator_id,model=adapter.model,rubric_sha256=request.rubric_sha256,
            request_sha256=request.request_sha256,status=status,reason=reason if reason else outcome.reason if outcome else None,
            judgment=outcome.judgment if outcome and status == "completed" else None,attempt_ids=ids,
            elapsed_seconds=max(0,loop.time()-pair_started.get(pair.pair_id,loop.time())))
        assessments[pair.pair_id] = assessment
        assessment_refs[pair.pair_id] = record(assessment,"assessment")
        if status == "completed":
            manifest["cache"][pair.pair_id] = resume_key(snapshot.snapshot_sha256,pair,request)
        persist()

    async def worker():
        nonlocal failure
        while queue:
            if cancel.is_set() or failure or storage_failed or loop.time() >= deadline:
                return
            pair = queue.popleft()
            request = requests[pair.pair_id]
            pair_started[pair.pair_id] = loop.time()
            for index in range(limits.retries + 1):
                async with dispatch:
                    if cancel.is_set() or failure or storage_failed or loop.time() >= deadline:
                        return
                    attempt = AttemptRecord(attempt_id=uuid.uuid4().hex,pair_id=pair.pair_id,
                        request_sha256=request.request_sha256,started_at=_utc())
                    attempts[attempt.attempt_id] = attempt
                    pair_attempts.setdefault(pair.pair_id,[]).append(attempt.attempt_id)
                    attempt_refs[attempt.attempt_id] = record(attempt,"attempt")
                    persist()
                attempt_started = loop.time()
                submitted = False
                try:
                    if cancel.is_set():
                        raise asyncio.CancelledError
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        raise TimeoutError
                    submitted = True
                    async with asyncio.timeout(min(limits.attempt_seconds,remaining)):
                        outcome = await adapter.attempt(request)
                except TimeoutError:
                    outcome = AttemptOutcome(reason="snapshot_deadline" if loop.time() >= deadline else "timeout",
                        retryable=loop.time() < deadline,submitted=submitted,elapsed_seconds=loop.time()-attempt_started)
                except asyncio.CancelledError:
                    if storage_failed:
                        return
                    outcome = AttemptOutcome(reason="cancelled" if cancel.is_set() else "snapshot_deadline",
                        submitted=submitted,elapsed_seconds=loop.time()-attempt_started)
                except Exception:
                    outcome = AttemptOutcome(reason="adapter_failure",stop_evaluator=True,submitted=submitted,
                                             elapsed_seconds=loop.time()-attempt_started)
                if storage_failed:
                    return
                attempts[attempt.attempt_id] = attempt.model_copy(update={"ended_at":_utc(), "outcome":outcome})
                attempt_refs[attempt.attempt_id] = record(attempts[attempt.attempt_id],"attempt")
                if outcome.stop_evaluator:
                    failure = outcome.reason
                persist()
                if outcome.judgment:
                    finish(pair,outcome=outcome)
                    break
                if cancel.is_set():
                    finish(pair,reason="cancelled",status="cancelled")
                    return
                if loop.time() >= deadline:
                    finish(pair,reason="snapshot_deadline",status="failed")
                    return
                if not outcome.retryable or index >= limits.retries or failure:
                    finish(pair,outcome=outcome)
                    break
                delay = outcome.retry_after_seconds if outcome.retry_after_seconds is not None else .25 + random.uniform(0,.25)
                if delay >= deadline - loop.time():
                    finish(pair,reason="retry_exceeds_budget",status="failed")
                    break
                try:
                    await asyncio.wait_for(cancel.wait(), timeout=delay)
                except TimeoutError:
                    pass

    workers = [asyncio.create_task(worker()) for _ in range(limits.concurrency)]
    cancelled = asyncio.create_task(cancel.wait())
    group = asyncio.gather(*workers)
    cleanup_started = None
    try:
        done, _ = await asyncio.wait([group,cancelled],timeout=max(0,deadline-loop.time()),return_when=asyncio.FIRST_COMPLETED)
        if group in done:
            await group
    except asyncio.CancelledError:
        cancel.set()
    finally:
        cleanup_started = loop.time()
        cancelled.cancel()
        for task in workers:
            if not task.done():
                task.cancel()
        done, pending = await asyncio.wait(workers,timeout=limits.cleanup_seconds)
        if pending:
            failure = "cleanup_timeout"
        for task in done:
            if not task.cancelled() and task.exception() is not None:
                if isinstance(task.exception(),LocalStorageFailure):
                    storage_failed = True
                else:
                    failure = "worker_failure"
        if group.done() and not group.cancelled():
            group.exception()  # Retrieve exceptions without logging provider data.
    if storage_failed:
        raise LocalStorageFailure()
    for pair in plan.pairs:
        if pair.pair_id not in assessments:
            dispatched = bool(pair_attempts.get(pair.pair_id))
            reason = "cancelled" if cancel.is_set() else failure or "snapshot_deadline"
            finish(pair,reason=reason,status="cancelled" if cancel.is_set() else "failed" if dispatched else "skipped")
    result = RunResult(run_id=store.run_id,snapshot_sha256=snapshot.snapshot_sha256,
        evaluator=adapter.evaluator_id,model=adapter.model,limits=limits,
        assessments=tuple(assessments[p.pair_id] for p in plan.pairs),coverage=plan.coverage,
        excluded_pairs=plan.excluded_pairs,attempts=tuple(attempts.values()),evaluator_failure=failure,
        elapsed_seconds=loop.time()-started,finalization_seconds=loop.time()-cleanup_started,
        started_at=started_at,experiment_sha256=experiment_sha256,
        evaluator_config_sha256=sha256_bytes(canonical_json({"evaluator":adapter.evaluator_id,"model":adapter.model,"config":getattr(adapter,"config",{})})))
    manifest["result_ref"] = record(result,"result")
    persist()
    return result
