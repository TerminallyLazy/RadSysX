import asyncio
import json
from pathlib import Path
import os
import signal

import pytest

from backend.evidence_review.serialization import canonical_json


def synthetic_services(**kwargs):
    from backend.evidence_review.cli import CLIServices
    from backend.evidence_review.settings import load_settings
    return CLIServices(settings_loader=lambda **ignored:load_settings(environ={},env_file=None),**kwargs)


def private_json(path,value):
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    path.write_bytes(canonical_json(value)); path.chmod(0o600)
    return path


def test_clinical_mode_before_settings(monkeypatch,tmp_path,capsys):
    from backend.evidence_review import cli
    monkeypatch.setenv('RADSYSX_APP_MODE','clinical')
    monkeypatch.setattr(cli,'load_settings',lambda **kw: pytest.fail('key read'))
    assert cli.main(['replay','--snapshot',str(tmp_path/'missing'),'--evaluator','jev'])==2
    assert 'evaluation_disabled' in capsys.readouterr().out


def test_help_never_loads_keys(monkeypatch):
    from backend.evidence_review import cli
    monkeypatch.setattr(cli,'load_settings',lambda **kw: pytest.fail('key read'))
    with pytest.raises(SystemExit) as stopped: cli.main(['--help'])
    assert stopped.value.code==0


def test_replay_resume_capture_and_offline_blind(snapshot_factory,tmp_path,monkeypatch,capsys):
    from backend.evidence_review import cli
    from backend.evidence_review.contracts import CaptureResult
    from backend.evidence_review.artifacts import ArtifactStore
    from backend.tests.evidence_review.test_runner import ScriptedEvaluator
    from backend.tests.evidence_review.test_report import tiny_manifest
    snap=snapshot_factory(); adapter=ScriptedEvaluator()
    async def capture(*a,**kw):
        return CaptureResult(result=snap.result,evidence=snap.evidence,capture_exclusions=(),generation=dict(snap.generation))
    services=synthetic_services(adapter_factory=lambda *a,**kw:adapter,capture=capture)
    query=private_json(tmp_path/'inputs'/'queries.json',{'schema_version':1,'data_class':'synthetic','queries':['Synthetic public query']})
    assert cli.main(['capture','--input',str(query),'--output-root',str(tmp_path/'capture')],services=services)==0
    receipt=json.loads(capsys.readouterr().out)
    captured=Path(receipt['exports'][0])
    assert json.loads(captured.read_bytes())['answer_sha256']==snap.answer_sha256
    assert cli.main(['replay','--snapshot',str(captured),'--evaluator','jev','--output-root',str(tmp_path/'runs')],services=services)==0
    receipt=json.loads(capsys.readouterr().out); run=Path(receipt['run'])
    assert cli.main(['resume','--run',str(run)],services=services)==0
    capsys.readouterr()
    assert len(adapter.bodies)==1
    monkeypatch.setattr(cli,'load_settings',lambda **kw: pytest.fail('key read'))
    monkeypatch.setenv('RADSYSX_APP_MODE','clinical')
    private_json(tmp_path/'study'/'snapshot.json',snap.model_dump(mode='json'))
    suite=tiny_manifest(snap).model_copy(update={'snapshots':{snap.snapshot_sha256:'snapshot.json'}})
    path=private_json(tmp_path/'study'/'suite.json',suite.model_dump(mode='json'))
    assert cli.main(['validate-suite','--suite',str(path)])==0
    capsys.readouterr()
    assert cli.main(['blind','--suite',str(path),'--output-root',str(tmp_path/'blind')])==0
    receipt=json.loads(capsys.readouterr().out)
    assert all(Path(p).stat().st_mode & 0o777==0o600 for p in receipt['exports'])


def test_missing_key_is_saved_without_raw_error(snapshot_factory,tmp_path,capsys):
    from backend.evidence_review import cli
    path=private_json(tmp_path/'input'/'snap.json',snapshot_factory().model_dump(mode='json'))
    assert cli.main(['replay','--snapshot',str(path),'--evaluator','jev','--env-file',str(tmp_path/'absent'),
        '--output-root',str(tmp_path/'runs')])==3
    receipt=json.loads(capsys.readouterr().out)
    from backend.evidence_review.artifacts import ArtifactStore
    run=Path(receipt['run'])
    with ArtifactStore.open(run.parent,run_id=run.name) as store:
        assert store.load_run().result.evaluator_failure=='missing_credential'


def test_invalid_inputs_do_not_leak_and_manifest_cannot_escape(snapshot_factory,tmp_path,capsys):
    from backend.evidence_review import cli
    path=private_json(tmp_path/'input'/'snap.json',{'secret':'PRIVATE_CANARY'})
    assert cli.main(['replay','--snapshot',str(path),'--evaluator','jev'])==2
    assert 'PRIVATE_CANARY' not in capsys.readouterr().out
    from backend.tests.evidence_review.test_report import tiny_manifest
    snap=snapshot_factory(); suite=tiny_manifest(snap).model_copy(update={'snapshots':{snap.snapshot_sha256:'../snap.json'}})
    path=private_json(tmp_path/'input'/'suite.json',suite.model_dump(mode='json'))
    assert cli.main(['validate-suite','--suite',str(path)])==2


def test_sigint_returns_durable_cancellation(snapshot_factory,tmp_path,capsys):
    from backend.evidence_review import cli
    from backend.tests.evidence_review.test_runner import ScriptedEvaluator
    async def interrupt():
        os.kill(os.getpid(),signal.SIGINT)
        await asyncio.Event().wait()
    services=synthetic_services(adapter_factory=lambda *a,**kw:ScriptedEvaluator([interrupt]))
    path=private_json(tmp_path/'input'/'snap.json',snapshot_factory().model_dump(mode='json'))
    assert cli.main(['replay','--snapshot',str(path),'--evaluator','jev','--output-root',str(tmp_path/'runs')],services=services)==130
    receipt=json.loads(capsys.readouterr().out)
    assert receipt['status']=='cancelled'


def test_reference_freeze_and_comparison_are_offline(snapshot_factory,tmp_path,monkeypatch,capsys):
    from backend.evidence_review import cli
    from backend.tests.evidence_review.test_report import tiny_manifest
    from backend.tests.evidence_review.test_runner import ScriptedEvaluator
    from backend.tests.evidence_review.test_study import review
    snap=snapshot_factory(); suite=tiny_manifest(snap).model_copy(update={'snapshots':{snap.snapshot_sha256:'snapshot.json'}})
    base=tmp_path/'private'
    base.mkdir(mode=0o700)
    snapshot=private_json(base/'study'/'snapshot.json',snap.model_dump(mode='json'))
    suite_path=private_json(base/'study'/'suite.json',suite.model_dump(mode='json'))
    services=synthetic_services(adapter_factory=lambda *a,**kw:ScriptedEvaluator())
    assert cli.main(['replay','--snapshot',str(snapshot),'--evaluator','jev','--output-root',str(base)],services=services)==0
    run=Path(json.loads(capsys.readouterr().out)['run'])
    monkeypatch.setattr(cli,'load_settings',lambda **kw: pytest.fail('key read'))
    labels=private_json(base/'study'/'reviews.json',[review(suite.cases[0],name).model_dump(mode='json') for name in ('fixture-a','fixture-b')])
    adjudications=private_json(base/'study'/'adjudications.json',[])
    assert cli.main(['freeze-references','--suite',str(suite_path),'--reviews',str(labels),'--adjudications',str(adjudications),
        '--output-root',str(base)])==0
    refs=Path(json.loads(capsys.readouterr().out)['exports'][0])
    runs=private_json(base/'runs.json',{'schema_version':1,'runs':[run.name]})
    assert cli.main(['compare','--suite',str(suite_path),'--references',str(refs),'--runs',str(runs),'--output-root',str(base)])==0
    outputs=json.loads(capsys.readouterr().out)['exports']
    comparison=json.loads(Path(outputs[0]).read_bytes())
    assert comparison['evaluators']['jev:jev-1.13.0']['classification']['accuracy']['value']==1.0


def test_cli_network_test_defaults_never_read_operator_dotenv(snapshot_factory,tmp_path,monkeypatch,capsys):
    from backend.evidence_review import cli
    from backend.tests.evidence_review.test_runner import ScriptedEvaluator
    import dotenv
    monkeypatch.chdir(tmp_path)
    private_json(tmp_path/'.env.ai',{'not':'dotenv'})
    def forbidden(*args,**kwargs): raise AssertionError('operator dotenv read')
    monkeypatch.setattr(dotenv,'dotenv_values',forbidden)
    path=private_json(tmp_path/'input'/'snap.json',snapshot_factory().model_dump(mode='json'))
    # Use the same synthetic service builder as the other network CLI tests.
    services=synthetic_services(adapter_factory=lambda *a,**kw:ScriptedEvaluator())
    assert cli.main(['replay','--snapshot',str(path),'--evaluator','jev','--output-root',str(tmp_path/'runs')],services=services)==0


def test_export_failure_is_storage_failure_with_run_locator(snapshot_factory,tmp_path,monkeypatch,capsys):
    from backend.evidence_review import cli
    from backend.evidence_review.artifacts import ArtifactStore
    from backend.tests.evidence_review.test_runner import ScriptedEvaluator
    path=private_json(tmp_path/'input'/'snap.json',snapshot_factory().model_dump(mode='json'))
    def fail(*args,**kwargs): raise OSError('PRIVATE_STORAGE_CANARY')
    monkeypatch.setattr(ArtifactStore,'export',fail)
    services=synthetic_services(adapter_factory=lambda *a,**kw:ScriptedEvaluator())
    assert cli.main(['replay','--snapshot',str(path),'--evaluator','jev','--output-root',str(tmp_path/'runs')],services=services)==3
    receipt=json.loads(capsys.readouterr().out)
    assert receipt['error']=='local_storage_failure' and Path(receipt['run']).is_dir()
    assert 'PRIVATE_STORAGE_CANARY' not in json.dumps(receipt)
