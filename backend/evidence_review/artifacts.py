"""Private, immutable POSIX artifacts. All I/O is relative to verified descriptors."""
from dataclasses import dataclass
import fcntl
import os
from pathlib import Path
import re
import stat
import uuid

from pydantic import BaseModel

from .contracts import Assessment, AttemptRecord, Limits, RunResult, Snapshot, load_snapshot
from .serialization import canonical_json, parse_json, sha256_bytes

MAX_OBJECT = 16 * 1024 * 1024
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}\Z")
REF = re.compile(r"([a-z][a-z_-]{0,30})-([a-f0-9]{64})\Z")
EXPORTS = {"snapshot.json", "report.html", "blind.html", "blind.json", "comparison.html", "comparison.json", "references.json"}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def _check(fd, *, directory=False, private=True):
    info = os.fstat(fd)
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError("unsafe_artifact_type")
    if private and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600)):
        raise ValueError("unsafe_artifact_permissions")


def _directory(parent, name, *, create=False, exclusive=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            os.fsync(parent)
        except FileExistsError:
            if exclusive:
                raise ValueError("run_exists") from None
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    try:
        _check(fd, directory=True)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _root(path, *, create):
    if os.name != "posix":
        raise ValueError("private_storage_requires_posix")
    path = Path(os.path.abspath(path))
    fd = os.open(path.anchor, DIR_FLAGS)
    try:
        parts = path.parts[1:]
        for index, part in enumerate(parts):
            try:
                child = os.open(part, DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o700, dir_fd=fd)
                os.fsync(fd)
                child = os.open(part, DIR_FLAGS, dir_fd=fd)
            try:
                _check(child, directory=True, private=index == len(parts) - 1)
            except BaseException:
                os.close(child)
                raise
            os.close(fd)
            fd = child
        if not parts:
            raise ValueError("unsafe_artifact_root")
        return fd, path
    except BaseException:
        os.close(fd)
        raise


def _read(directory, name, maximum):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        _check(fd)
        if not 0 <= os.fstat(fd).st_size <= maximum:
            raise ValueError("artifact_too_large")
        chunks = []
        remaining = maximum + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > maximum:
            raise ValueError("artifact_too_large")
        return data
    finally:
        os.close(fd)


def _install(directory, name, data, *, replace=False):
    temp = ".pending-" + uuid.uuid4().hex
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temp, name, src_dir_fd=directory, dst_dir_fd=directory)
        else:
            try:
                os.link(temp, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            except FileExistsError:
                if _read(directory, name, len(data)) != data:
                    raise ValueError("artifact_conflict") from None
        os.fsync(directory)
    finally:
        try:
            os.unlink(temp, dir_fd=directory)
        except FileNotFoundError:
            pass


@dataclass(frozen=True)
class RunView:
    manifest: dict
    snapshot: Snapshot | None = None
    request_refs: tuple[str, ...] = ()
    attempts: tuple[AttemptRecord, ...] = ()
    assessments: tuple[Assessment, ...] = ()
    result: RunResult | None = None
    interrupted_attempt_ids: tuple[str, ...] = ()


class ArtifactStore:
    @classmethod
    def create(cls, root: Path, *, run_id: str):
        return cls(root, run_id, create=True)

    @classmethod
    def open(cls, root: Path, *, run_id: str):
        return cls(root, run_id, create=False)

    def __init__(self, root, run_id, *, create):
        self._fds = []
        self.run_id = run_id
        if not NAME.fullmatch(run_id):
            raise ValueError("invalid_run_id")
        try:
            root_fd, path = _root(root, create=create)
            self._fds.append(root_fd)
            self.run_path = path / run_id
            self._run = _directory(root_fd, run_id, create=create, exclusive=create)
            self._fds.append(self._run)
            lock = os.open(".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self._run)
            self._fds.append(lock)
            _check(lock)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("run_busy") from None
            self._objects = _directory(self._run, "objects", create=create)
            self._fds.append(self._objects)
        except BaseException:
            self.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        for fd in reversed(self._fds):
            os.close(fd)
        self._fds.clear()

    def put_bytes(self, data: bytes, *, kind: str) -> str:
        if not isinstance(data, bytes) or len(data) > MAX_OBJECT or not re.fullmatch(r"[a-z][a-z_-]{0,30}", kind):
            raise ValueError("invalid_artifact")
        ref = kind + "-" + sha256_bytes(data)
        _install(self._objects, ref, data)
        return ref

    def put_record(self, record: BaseModel, *, kind: str) -> str:
        return self.put_bytes(canonical_json(record.model_dump(mode="json")), kind=kind)

    def read_bytes(self, ref: str, *, max_bytes: int = MAX_OBJECT) -> bytes:
        match = REF.fullmatch(ref)
        if match is None or not 0 <= max_bytes <= MAX_OBJECT:
            raise ValueError("invalid_artifact_reference")
        data = _read(self._objects, ref, max_bytes)
        if sha256_bytes(data) != match[2]:
            raise ValueError("artifact_hash_mismatch")
        return data

    def commit_manifest(self, manifest: dict) -> str:
        if manifest.get("schema_version") != 1 or not isinstance(manifest.get("objects"), list):
            raise ValueError("invalid_manifest")
        for ref in manifest["objects"]:
            self.read_bytes(ref)
        # Every semantic reference must also be part of the durable object set.
        for key, value in manifest.items():
            refs = [value] if key.endswith("_ref") and value is not None else value if key.endswith("_refs") else []
            if any(ref not in manifest["objects"] for ref in refs):
                raise ValueError("uncommitted_reference")
        ref = self.put_bytes(canonical_json(manifest), kind="manifest")
        try:
            head = _read(self._run, "HEAD", 100)
            if not REF.fullmatch(head.decode("ascii")):
                raise ValueError("invalid_manifest_pointer")
        except FileNotFoundError:
            pass
        _install(self._run, "HEAD", ref.encode("ascii"), replace=True)
        return ref

    def load_run(self) -> RunView:
        ref = _read(self._run, "HEAD", 100).decode("ascii")
        manifest = parse_json(self.read_bytes(ref), max_bytes=MAX_OBJECT)
        if manifest.get("schema_version") != 1 or not isinstance(manifest.get("objects"), list):
            raise ValueError("invalid_manifest")
        for item in manifest["objects"]:
            self.read_bytes(item)
        def read(key):
            item = manifest[key]
            if item not in manifest["objects"]:
                raise ValueError("uncommitted_reference")
            return self.read_bytes(item)
        snapshot = load_snapshot(read("snapshot_ref"), limits=Limits()) if manifest.get("snapshot_ref") else None
        result = RunResult.model_validate_json(read("result_ref")) if manifest.get("result_ref") else None
        attempts = tuple(AttemptRecord.model_validate_json(self.read_bytes(item)) for item in manifest.get("attempt_refs", []))
        assessments = tuple(Assessment.model_validate_json(self.read_bytes(item)) for item in manifest.get("assessment_refs", []))
        for key in ("attempt_refs", "assessment_refs", "request_refs"):
            if any(item not in manifest["objects"] for item in manifest.get(key, [])):
                raise ValueError("uncommitted_reference")
        return RunView(manifest, snapshot, tuple(item for item in manifest["objects"] if item.startswith("request-")), attempts, assessments, result,
                       tuple(item.attempt_id for item in attempts if item.ended_at is None))

    def export(self, ref: str, *, name: str) -> Path:
        if name not in EXPORTS:
            raise ValueError("invalid_export_name")
        data = self.read_bytes(ref)
        exports = _directory(self._run, "exports", create=True)
        identifier = uuid.uuid4().hex
        try:
            destination = _directory(exports, identifier, create=True, exclusive=True)
            try:
                _install(destination, name, data)
            finally:
                os.close(destination)
        finally:
            os.close(exports)
        return self.run_path / "exports" / identifier / name
