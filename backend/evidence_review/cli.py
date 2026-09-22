"""Explicit operator commands; no application routes or automatic observation."""
import argparse
import asyncio
from contextlib import ExitStack
from dataclasses import dataclass, field
from datetime import datetime, timezone
import os
from pathlib import Path
import signal
from typing import Callable, Literal
import uuid

from pydantic import Field, TypeAdapter

from .artifacts import ArtifactStore, MAX_OBJECT, _directory, _read, _root
from .capture import capture_public_query
from .contracts import Limits, Record, ReviewPlan, SpanAnnotation, freeze_snapshot, load_snapshot
from .gemini import GeminiAdapter
from .metrics import compare_runs
from .report import blind_projection, render_blind, render_comparison, render_run
from .runner import LocalStorageFailure, evaluate_snapshot
from .serialization import canonical_json, parse_json, sha256_bytes
from .settings import check_network_mode, load_settings
from .study import Adjudication, ExperimentConfig, HumanLabel, ReferenceSet, StudyManifest, freeze_references, validate_study
from .transport import new_http_client
from .typesafe import TypeSafeAdapter
from .units import build_review_plan


class CaptureManifest(Record):
    data_class: Literal['public_literature','synthetic']
    queries: tuple[str,...] = Field(min_length=1,max_length=20)


@dataclass
class CLIServices:
    settings_loader: Callable | None = None
    adapter_factory: Callable | None = None
    client_factory: Callable = new_http_client
    capture: Callable = capture_public_query
    store_factory: type = ArtifactStore
    cancel: asyncio.Event = field(default_factory=asyncio.Event)


def read_private(path: Path, *, max_bytes=MAX_OBJECT) -> bytes:
    directory, _ = _root(path.parent,create=False)
    try:
        return _read(directory,path.name,max_bytes)
    finally:
        os.close(directory)


def _inside(base,relative):
    path = Path(relative)
    if path.is_absolute() or not path.parts or any(p in {'.','..'} for p in path.parts):
        raise ValueError('invalid_relative_path')
    return base/path


def _suite(path):
    manifest = StudyManifest.model_validate_json(read_private(path))
    snapshots = {digest:load_snapshot(read_private(_inside(path.parent,relative),max_bytes=Limits().snapshot_bytes),limits=Limits())
                 for digest,relative in manifest.snapshots.items()}
    return manifest,snapshots


def _print(value):
    print(canonical_json(value).decode())


def _create(services,root,prefix):
    return services.store_factory.create(root,run_id=prefix+'-'+uuid.uuid4().hex)


def _save(store,values):
    """Commit exports' source objects before materializing readable private files."""
    refs = [(store.put_bytes(data,kind=kind),name) for kind,name,data in values]
    try:
        manifest = store.load_run().manifest
    except FileNotFoundError:
        manifest = {'schema_version':1,'objects':[]}
    for ref,name in refs:
        if ref not in manifest['objects']: manifest['objects'].append(ref)
    store.commit_manifest(manifest)
    return [str(store.export(ref,name=name)) for ref,name in refs]


def _adapter(services,evaluator,settings,client,*,config=None,expected_resolved_model=None):
    if services.adapter_factory:
        return services.adapter_factory(evaluator,settings,client,config=config,expected_resolved_model=expected_resolved_model)
    if evaluator=='jev': return TypeSafeAdapter(settings.typesafe_key,client)
    if evaluator=='gemini': return GeminiAdapter(settings.gemini_key,client,config=config,expected_resolved_model=expected_resolved_model)
    raise ValueError('unsupported_evaluator')


async def _capture_one(function,query,*,cancel,**kwargs):
    task = asyncio.create_task(function(query,**kwargs)); signal_task = asyncio.create_task(cancel.wait())
    try:
        done,_ = await asyncio.wait([task,signal_task],return_when=asyncio.FIRST_COMPLETED)
        if signal_task in done:
            task.cancel()
            try: await task
            except asyncio.CancelledError: pass
            raise asyncio.CancelledError
        return await task
    finally:
        signal_task.cancel()


async def dispatch(args, *, services: CLIServices) -> int:
    network = args.command in {'capture','replay','resume'}
    if network:
        check_network_mode(os.environ)  # Must precede any settings loader or client.
    with ExitStack() as stack:
        if args.command=='capture':
            manifest = CaptureManifest.model_validate_json(read_private(args.input))
            if any(not 1 <= len(query.strip()) <= 2000 for query in manifest.queries): raise ValueError('invalid_query')
            settings = (services.settings_loader or load_settings)(environ=os.environ,env_file=args.env_file)
            store = stack.enter_context(_create(services,args.output_root,'capture'))
            exports = []
            try:
                for query in manifest.queries:
                    if services.cancel.is_set(): raise asyncio.CancelledError
                    captured = await _capture_one(services.capture,query,cancel=services.cancel,
                        api_key=settings.gemini_key.get_secret_value(),data_class=manifest.data_class,limits=Limits())
                    snapshot = freeze_snapshot({'snapshot_id':uuid.uuid4().hex,'created_at':datetime.now(timezone.utc).isoformat(),
                        'data_class':manifest.data_class,**captured.model_dump(mode='json',exclude={'schema_version'})},limits=Limits())
                    exports.extend(_save(store,[('snapshot','snapshot.json',canonical_json(snapshot.model_dump(mode='json')))]))
            except asyncio.CancelledError:
                _print({'status':'cancelled','run':str(store.run_path),'exports':exports}); return 130
            except (ValueError,OSError):
                _print({'status':'capture_failed','run':str(store.run_path),'exports':exports}); return 3
            _print({'status':'completed','run':str(store.run_path),'exports':exports}); return 0

        if args.command in {'replay','resume'}:
            resume = None; experiment = None; config = None; resolved = None; experiment_hash = None
            if args.command=='resume':
                store = stack.enter_context(services.store_factory.open(args.run.parent,run_id=args.run.name))
                resume = store.load_run()
                if resume.snapshot is None: raise ValueError('missing_snapshot')
                snapshot = resume.snapshot
                plan = ReviewPlan.model_validate_json(store.read_bytes(resume.manifest['plan_ref']))
                limits = Limits.model_validate_json(canonical_json(resume.manifest['limits']))
                evaluator = resume.manifest['evaluator']
                config = resume.manifest.get('config') or None
                resolved = resume.manifest.get('expected_resolved_model')
                experiment_hash = resume.manifest.get('experiment_sha256')
            else:
                limits = Limits()
                if args.experiment:
                    experiment = ExperimentConfig.model_validate_json(read_private(args.experiment))
                    experiment_hash = experiment.sha256; limits = experiment.limits
                    config = experiment.generation_configs.get(args.evaluator)
                    resolved = experiment.resolved_models.get(args.evaluator)
                snapshot = load_snapshot(read_private(args.snapshot,max_bytes=limits.snapshot_bytes),limits=limits)
                annotations = TypeAdapter(tuple[SpanAnnotation,...]).validate_json(read_private(args.annotations)) if args.annotations else ()
                plan = build_review_plan(snapshot,limits=limits,annotations=annotations)
                evaluator = args.evaluator
                store = stack.enter_context(_create(services,args.output_root,evaluator))
            settings = (services.settings_loader or load_settings)(environ=os.environ,env_file=args.env_file)
            async with services.client_factory() as client:
                adapter = _adapter(services,evaluator,settings,client,config=config,expected_resolved_model=resolved)
                config_hash = sha256_bytes(canonical_json({'evaluator':adapter.evaluator_id,'model':adapter.model,'config':getattr(adapter,'config',{})}))
                if experiment is not None and (experiment.models.get(evaluator) != adapter.model
                        or experiment.config_hashes.get(evaluator) != config_hash or not resolved):
                    raise ValueError('experiment_mismatch')
                if resume is not None:
                    if resume.manifest['model'] != adapter.model:
                        raise ValueError('resume_model_mismatch')
                    prior = {sha256_bytes(store.read_bytes(ref)) for ref in resume.request_refs}
                    if any(adapter.prepare(pair).request_sha256 not in prior for pair in plan.pairs):
                        raise ValueError('resume_request_mismatch')
                result = await evaluate_snapshot(snapshot,plan,adapter=adapter,store=store,limits=limits,
                    cancel=services.cancel,resume=resume,experiment_sha256=experiment_hash)
            exports = _save(store,[('report','report.html',render_run(snapshot,plan,result).encode())])
            code = 130 if services.cancel.is_set() else 3 if any(a.status != 'completed' for a in result.assessments) or result.evaluator_failure else 0
            _print({'status':'cancelled' if code==130 else 'partial' if code else 'completed','run':str(store.run_path),'exports':exports})
            return code

        manifest,snapshots = _suite(args.suite)
        if args.command=='validate-suite':
            refs = ReferenceSet.model_validate_json(read_private(args.references)) if args.references else None
            validation = validate_study(manifest,snapshots,references=refs,require_target=args.require_target)
            _print(validation.model_dump(mode='json'))
            return 0 if validation.input_ready and (refs is None or validation.references_ready) else 2
        if not validate_study(manifest,snapshots,require_target=False).input_ready: raise ValueError('invalid_study')
        store = stack.enter_context(_create(services,args.output_root,args.command))
        if args.command=='blind':
            projection = blind_projection(manifest,snapshots)
            values = [('blind','blind.json',canonical_json(projection)),('blind-html','blind.html',render_blind(projection).encode())]
        elif args.command=='freeze-references':
            reviews_bytes = read_private(args.reviews)
            adjudication_bytes = read_private(args.adjudications)
            reviews = TypeAdapter(tuple[HumanLabel,...]).validate_json(reviews_bytes)
            adjudications = TypeAdapter(tuple[Adjudication,...]).validate_json(adjudication_bytes)
            refs = freeze_references(manifest,reviews,adjudications)
            # Keep original attested inputs, including notes, separate from model requests.
            review_ref = store.put_bytes(reviews_bytes,kind='human-reviews')
            adjudication_ref = store.put_bytes(adjudication_bytes,kind='adjudications')
            store.commit_manifest({'schema_version':1,'objects':[review_ref,adjudication_ref]})
            values = [('references','references.json',canonical_json(refs.model_dump(mode='json')))]
        elif args.command=='compare':
            refs = ReferenceSet.model_validate_json(read_private(args.references))
            run_list = parse_json(read_private(args.runs),max_bytes=MAX_OBJECT)
            if not isinstance(run_list,dict) or set(run_list)!={'schema_version','runs'} or run_list['schema_version']!=1 or not isinstance(run_list['runs'],list) or len(run_list['runs'])>1000:
                raise ValueError('invalid_run_list')
            runs = []
            for relative in run_list['runs']:
                path = _inside(args.runs.parent,relative)
                with services.store_factory.open(path.parent,run_id=path.name) as source:
                    run = source.load_run().result
                    if run is None: raise ValueError('unfinished_run')
                    runs.append(run)
            comparison = compare_runs(manifest,refs,runs,snapshots=snapshots)
            values = [('comparison','comparison.json',canonical_json(comparison.model_dump(mode='json'))),
                      ('comparison-html','comparison.html',render_comparison(comparison).encode())]
        else:
            raise ValueError('unsupported_command')
        exports = _save(store,values)
        _print({'status':'completed','run':str(store.run_path),'exports':exports})
        return 0


def parser():
    root = argparse.ArgumentParser(description='Explicit public/synthetic evidence review; never changes assistant answers.')
    commands = root.add_subparsers(dest='command',required=True)
    for name in ('capture','replay','resume','blind','freeze-references','validate-suite','compare'):
        command = commands.add_parser(name)
        if name in {'capture','replay','resume'}: command.add_argument('--env-file',type=Path,default=Path('.env.ai'))
        if name not in {'resume','validate-suite'}: command.add_argument('--output-root',type=Path,default=Path('tmp/jev-evaluations'))
        if name=='capture': command.add_argument('--input',type=Path,required=True)
        if name=='replay':
            command.add_argument('--snapshot',type=Path,required=True)
            command.add_argument('--evaluator',choices=['jev','gemini'],required=True)
            command.add_argument('--annotations',type=Path)
            command.add_argument('--experiment',type=Path)
        if name=='resume': command.add_argument('--run',type=Path,required=True)
        if name in {'blind','freeze-references','validate-suite','compare'}: command.add_argument('--suite',type=Path,required=True)
        if name in {'validate-suite','compare'}: command.add_argument('--references',type=Path,required=name=='compare')
        if name=='validate-suite': command.add_argument('--require-target',action='store_true')
        if name=='compare': command.add_argument('--runs',type=Path,required=True)
        if name=='freeze-references':
            command.add_argument('--reviews',type=Path,required=True)
            command.add_argument('--adjudications',type=Path,required=True)
    return root


def main(argv=None, *, services=None):
    args = parser().parse_args(argv)
    services = services or CLIServices()
    async def invoke():
        loop = asyncio.get_running_loop()
        for item in (signal.SIGINT,signal.SIGTERM): loop.add_signal_handler(item,services.cancel.set)
        try:
            return await dispatch(args,services=services)
        finally:
            for item in (signal.SIGINT,signal.SIGTERM): loop.remove_signal_handler(item)
    try:
        return asyncio.run(invoke())
    except LocalStorageFailure:
        _print({'error':'local_storage_failure'}); return 3
    except (ValueError,TypeError,KeyError,OSError):
        reason = 'evaluation_disabled' if args.command in {'capture','replay','resume'} and os.environ.get('RADSYSX_APP_MODE','research') not in {'research','pilot'} else 'input_or_configuration_rejected'
        _print({'error':reason}); return 2
    except (KeyboardInterrupt,asyncio.CancelledError):
        _print({'status':'cancelled'}); return 130
