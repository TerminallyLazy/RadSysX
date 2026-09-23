import os
from pathlib import Path
import subprocess
import sys

import pytest


def test_private_immutable_objects_and_exports(tmp_path):
    from backend.evidence_review.artifacts import ArtifactStore
    with ArtifactStore.create(tmp_path/'private',run_id='run-1') as store:
        ref=store.put_bytes(b'original',kind='request')
        assert store.put_bytes(b'original',kind='request')==ref
        assert store.read_bytes(ref,max_bytes=1024)==b'original'
        assert store.run_path.stat().st_mode & 0o777 == 0o700
        exported=store.export(ref,name='snapshot.json')
        assert exported.read_bytes()==b'original'
        assert exported.stat().st_mode & 0o777 == 0o600
        assert store.export(ref,name='snapshot.json')!=exported
        with pytest.raises(ValueError): store.export(ref,name='../leak')


def test_orphan_not_committed_and_manifest_failure_preserves_previous(tmp_path,monkeypatch):
    from backend.evidence_review.artifacts import ArtifactStore
    with ArtifactStore.create(tmp_path/'private',run_id='run-2') as store:
        ref=store.put_bytes(b'orphan',kind='request')
        store.commit_manifest({'schema_version':1,'objects':[]})
        assert store.load_run().request_refs==()
        def failed(*a,**kw): raise OSError('private-path')
        monkeypatch.setattr(os,'replace',failed)
        with pytest.raises(OSError):
            store.commit_manifest({'schema_version':1,'objects':[ref]})
        assert store.load_run().request_refs==()


@pytest.mark.parametrize('kind',['symlink','permissions','fifo'])
def test_unsafe_existing_root_rejected(tmp_path,kind):
    from backend.evidence_review.artifacts import ArtifactStore
    root=tmp_path/'unsafe'
    if kind=='symlink': root.symlink_to(tmp_path,target_is_directory=True)
    elif kind=='fifo': os.mkfifo(root)
    else: root.mkdir(mode=0o755)
    with pytest.raises((ValueError,OSError)):
        ArtifactStore.create(root,run_id='safe')


def test_path_traversal_hash_tampering_and_oversize(tmp_path):
    from backend.evidence_review.artifacts import ArtifactStore
    with ArtifactStore.create(tmp_path/'private',run_id='safe') as store:
        ref=store.put_bytes(b'original',kind='request')
        for name in ('../secret','/etc/passwd','request-nohash'):
            with pytest.raises(ValueError): store.read_bytes(name,max_bytes=1024)
        with pytest.raises(ValueError): store.read_bytes(ref,max_bytes=2)
        # Deliberate corruption of a local artifact must be detected, not reused.
        (store.run_path/'objects'/ref).write_bytes(b'changed!')
        with pytest.raises(ValueError): store.read_bytes(ref,max_bytes=1024)


def test_second_writer_cannot_enter_run(tmp_path):
    from backend.evidence_review.artifacts import ArtifactStore
    root=tmp_path/'private'
    with ArtifactStore.create(root,run_id='safe'):
        script='from backend.evidence_review.artifacts import ArtifactStore; import sys; ArtifactStore.open(__import__("pathlib").Path(sys.argv[1]),run_id="safe")'
        result=subprocess.run([sys.executable,'-c',script,str(root)],capture_output=True,text=True,timeout=10)
        assert result.returncode != 0 and 'run_busy' in result.stderr
    with ArtifactStore.open(root,run_id='safe'):
        pass


def test_object_symlink_and_fifo_do_not_get_read(tmp_path):
    from backend.evidence_review.artifacts import ArtifactStore
    with ArtifactStore.create(tmp_path/'private',run_id='safe') as store:
        ref='request-'+'0'*64
        path=store.run_path/'objects'/ref
        path.symlink_to(tmp_path/'absent')
        with pytest.raises((OSError,ValueError)): store.read_bytes(ref,max_bytes=1024)
        path.unlink(); os.mkfifo(path)
        with pytest.raises((OSError,ValueError)): store.read_bytes(ref,max_bytes=1024)


def test_symlinked_parent_and_reused_run_rejected(tmp_path):
    from backend.evidence_review.artifacts import ArtifactStore
    (tmp_path/'alias').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(OSError): ArtifactStore.create(tmp_path/'alias'/'private',run_id='safe')
    with ArtifactStore.create(tmp_path/'private',run_id='safe'):
        with pytest.raises(ValueError): ArtifactStore.create(tmp_path/'private',run_id='safe')


def test_interrupted_attempt_is_retained(tmp_path):
    from datetime import datetime, timezone
    from backend.evidence_review.artifacts import ArtifactStore
    from backend.evidence_review.contracts import AttemptRecord
    with ArtifactStore.create(tmp_path/'private',run_id='safe') as store:
        attempt = AttemptRecord(attempt_id='a1',pair_id='p1',request_sha256='0'*64,started_at=datetime.now(timezone.utc))
        ref=store.put_record(attempt,kind='attempt')
        store.commit_manifest({'schema_version':1,'objects':[ref],'attempt_refs':[ref]})
        assert store.load_run().interrupted_attempt_ids==('a1',)
        assert store.load_run().attempts[0].outcome is None


def test_failed_object_fsync_does_not_replace_manifest(tmp_path,monkeypatch):
    from backend.evidence_review.artifacts import ArtifactStore
    with ArtifactStore.create(tmp_path/'private',run_id='safe') as store:
        store.commit_manifest({'schema_version':1,'objects':[]})
        def fail(*args): raise OSError('injected')
        monkeypatch.setattr(os,'fsync',fail)
        with pytest.raises(OSError): store.put_bytes(b'new',kind='request')
        assert store.load_run().request_refs==()


def test_explicit_delete_is_locked_and_does_not_follow_symlinks(tmp_path):
    from backend.evidence_review.artifacts import ArtifactStore
    root=tmp_path/'private'
    with ArtifactStore.create(root,run_id='delete') as store:
        store.put_bytes(b'fixture',kind='test')
        with pytest.raises(ValueError,match='run_busy'):
            ArtifactStore.delete_run(root,run_id='delete')
    outside=tmp_path/'outside'; outside.write_text('untouched')
    (root/'delete'/'objects'/'hostile').symlink_to(outside)
    with pytest.raises((ValueError,OSError)):
        ArtifactStore.delete_run(root,run_id='delete')
    assert outside.read_text()=='untouched'
    (root/'delete'/'objects'/'hostile').unlink()
    ArtifactStore.delete_run(root,run_id='delete')
    assert not (root/'delete').exists()


def test_review_preview_keeps_large_valid_unicode_sources_readable(snapshot_factory,tmp_path):
    from backend.clinical.ai_evidence_artifacts import ReviewArtifacts
    from backend.evidence_review.units import build_review_plan
    from backend.evidence_review.contracts import Limits
    citations=' '.join(f'[s{i}]' for i in range(1,21))
    snap=snapshot_factory(answer=(('𠀀'*5800)+' '+citations+'. ')*2,abstract='🧪'*10000,evidence_count=20)
    plan=build_review_plan(snap,limits=Limits())
    assert len(plan.pairs)==40
    artifacts=ReviewArtifacts(tmp_path/'private','large-preview')
    ref,digest=artifacts.create_preview(snap,plan,{'providerId':None,'modelId':None,'recordedAt':None})
    restored=artifacts.read_preview(ref)
    assert restored['snapshot']==snap and restored['preview_hash']==digest
