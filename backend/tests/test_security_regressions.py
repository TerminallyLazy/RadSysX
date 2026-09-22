"""Synthetic regression coverage for the GitHub security findings."""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("RADSYSX_SESSION_COOKIE_SECURE", "false")
from backend import server
from backend.biomedparse_demo import biomedparse_demo_artifact_path

SENSITIVE = "synthetic-private-record /private/server/config.py bearer-test-token"
ROOT = Path(__file__).resolve().parents[2]


def fail(*args, **kwargs):
    raise RuntimeError(SENSITIVE)


async def fail_async(*args, **kwargs):
    fail()


async def fail_stream(*args, **kwargs):
    fail()
    yield "unreachable"


@pytest.mark.parametrize("path,payload,target", [
    ("/process", {"query": "synthetic"}, "process_query"),
    ("/mcp/toggle", {"enabled": True}, "enable_disable_mcp"),
    ("/chat", {"message": "synthetic"}, "get_chat_interface"),
    ("/tools", None, "get_chat_interface"),
])
def test_api_failures_do_not_expose_exception_details(monkeypatch, capsys, path, payload, target):
    monkeypatch.setattr(server, target, fail)
    client = TestClient(server.app)
    response = client.get(path) if payload is None else client.post(path, json=payload)
    assert "error" in response.json()
    assert SENSITIVE not in response.text
    assert SENSITIVE not in capsys.readouterr().out


@pytest.mark.parametrize("error_type", [RuntimeError, ValueError])
def test_fhir_failures_are_private(monkeypatch, capsys, error_type):
    async def fail_fhir(*args):
        raise error_type(SENSITIVE)
    monkeypatch.setattr(server, "_execute_fhir_tool_request", fail_fhir)
    response = TestClient(server.app).post("/fhir/tool", json={"tool": "list_fhir_resources", "params": {}})
    assert "error" in response.json()
    assert SENSITIVE not in response.text + capsys.readouterr().out


@pytest.mark.parametrize("path,payload", [
    ("/stream", {"query": SENSITIVE}),
    ("/chat/stream", {"message": SENSITIVE}),
])
def test_stream_failure_is_safe_and_terminates(monkeypatch, capsys, path, payload):
    monkeypatch.setattr(server, "enable_disable_mcp", lambda enabled: enabled)
    monkeypatch.setattr(server, "stream_query", fail_stream)
    monkeypatch.setattr(server, "get_chat_interface", lambda: SimpleNamespace(stream_chat=fail_stream))
    response = TestClient(server.app).post(path, json=payload)
    assert '"error"' in response.text
    assert response.text.endswith("data: [DONE]\n\n")
    assert SENSITIVE not in response.text + capsys.readouterr().out


def test_fhir_fallback_does_not_echo_import_failure_or_params():
    fallback = server._FallbackFHIRServer(RuntimeError(SENSITIVE))
    response = asyncio.run(fallback.call_tool("test", {"patient_id": SENSITIVE}))
    assert "unavailable" in response["error"]
    assert SENSITIVE not in json.dumps(response)


@pytest.mark.parametrize("run_id", ["../private", "/tmp/private", "bmp-" + "a" * 32 + "\n", "bmp-" + "a" * 32 + "/../private", "bmp-..\\private"])
def test_artifact_rejects_invalid_run_ids(tmp_path, monkeypatch, run_id):
    monkeypatch.setenv("RADSYSX_BIOMEDPARSE_RUNS_DIR", str(tmp_path))
    with pytest.raises(server.HTTPException) as error:
        biomedparse_demo_artifact_path(run_id, "mask.npz")
    assert error.value.status_code == 400


@pytest.mark.parametrize("symlink_kind", ["run", "artifact"])
def test_artifact_rejects_symlinks(tmp_path, monkeypatch, symlink_kind):
    root = tmp_path / "runs"
    root.mkdir()
    outside = tmp_path / "runs-sibling"
    outside.mkdir()
    (outside / "mask.npz").write_bytes(b"private")
    run_id = "bmp-" + "a" * 32
    run = root / run_id
    if symlink_kind == "run":
        run.symlink_to(outside, target_is_directory=True)
    else:
        run.mkdir()
        (run / "mask.npz").symlink_to(outside / "mask.npz")
    monkeypatch.setenv("RADSYSX_BIOMEDPARSE_RUNS_DIR", str(root))
    with pytest.raises(server.HTTPException) as error:
        biomedparse_demo_artifact_path(run_id, "mask.npz")
    assert error.value.status_code == 403


def test_artifact_rejects_non_allowlisted_file(tmp_path, monkeypatch):
    monkeypatch.setenv("RADSYSX_BIOMEDPARSE_RUNS_DIR", str(tmp_path))
    with pytest.raises(server.HTTPException) as error:
        biomedparse_demo_artifact_path("bmp-" + "a" * 32, "../../secret")
    assert error.value.status_code == 400


def load_script(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_anonymizer_verbose_output_omits_patient_values(tmp_path, monkeypatch, capsys):
    import pydicom
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid
    module = load_script("anonymizer", "backend/skills/pydicom/scripts/anonymize_dicom.py")
    source = tmp_path / "synthetic-private-name.dcm"
    dest = tmp_path / "synthetic-private-output.dcm"
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    dataset = FileDataset(str(source), {}, file_meta=meta, preamble=b"\0" * 128)
    dataset.PatientID = "ORIGINAL-PRIVATE-ID"
    dataset.PatientName = "ORIGINAL^PRIVATE"
    dataset.save_as(source, enforce_file_format=True)
    monkeypatch.setattr("sys.argv", ["anonymize", str(source), str(dest), "--patient-id", "REPLACEMENT-ID", "--patient-name", "REPLACEMENT^NAME", "--verbose"])
    module.main()
    output = capsys.readouterr().out
    for private in ["ORIGINAL", "REPLACEMENT", source.name, dest.name]:
        assert private not in output
    assert pydicom.dcmread(dest).PatientID == "REPLACEMENT-ID"
    assert "PatientID: replaced" in output


def test_legacy_server_failure_response_is_private(monkeypatch, capsys):
    module = load_script("legacy_server", "tests/simple_server.py")
    monkeypatch.setattr(module, "mock_stream_chat", fail_stream)
    response = TestClient(module.app).post("/chat", json={"message": "synthetic"})
    assert "error" in response.json()
    assert SENSITIVE not in response.text + capsys.readouterr().out


def test_failed_worker_does_not_expose_stderr(tmp_path, monkeypatch):
    from backend.biomedparse_demo import BiomedParseDemoRunRequest, run_biomedparse_demo
    from backend.tests.test_biomedparse_demo import configure_fake_worker
    configure_fake_worker(tmp_path, monkeypatch)
    Path(os.environ["RADSYSX_BIOMEDPARSE_WORKER_SCRIPT"]).write_text(
        f"import sys\nprint({SENSITIVE!r}, file=sys.stderr)\nsys.exit(1)\n"
    )
    with pytest.raises(server.HTTPException) as error:
        asyncio.run(run_biomedparse_demo(BiomedParseDemoRunRequest()))
    assert error.value.status_code == 502
    assert error.value.detail == "BioMedParse worker failed."


def test_mcp_smoke_logs_never_include_patient_payloads(monkeypatch, caplog):
    import sys
    import types

    class FakeServer:
        def __init__(self, **kwargs):
            pass
        async def initialize(self):
            pass
        async def list_resources(self, *args):
            return ["Patient"]
        async def call_tool(self, tool, params):
            if tool == "search_fhir_resources":
                return {"entry": [{"resource": {"id": SENSITIVE}}]}
            return {"name": SENSITIVE, "medications": [SENSITIVE]}

    class FakeClient:
        async def connect(self, server):
            pass
        async def list_resources(self):
            return ["Patient"]
        async def search_fhir_resources(self, *args):
            return {"entry": [{"resource": {"id": SENSITIVE}}]}
        async def get_patient_demographics(self, *args):
            return {"name": SENSITIVE}

    fake_package = types.ModuleType("mcp")
    fake_package.__path__ = []
    fake_client = types.ModuleType("mcp.client")
    fake_client.RadSysXMCPClient = FakeClient
    fake_server = types.ModuleType("mcp.fhir_server")
    fake_server.FHIRMCPServer = FakeServer
    for name, module in [("mcp", fake_package), ("mcp.client", fake_client), ("mcp.fhir_server", fake_server)]:
        monkeypatch.setitem(sys.modules, name, module)
    module = load_script("mcp_smoke", "backend/test_mcp_integration.py")
    with caplog.at_level("INFO", logger="mcp_test"):
        asyncio.run(module.test_mcp_client())
    assert "demographics request completed" in caplog.text
    assert SENSITIVE not in caplog.text
