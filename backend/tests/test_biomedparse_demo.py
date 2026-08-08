from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from fastapi import HTTPException
from fastapi.testclient import TestClient

os.environ.setdefault("RADSYSX_SESSION_COOKIE_SECURE", "false")

try:
    from backend.biomedparse_demo import (
        BiomedParseDemoRunRequest,
        biomedparse_demo_artifact_path,
        biomedparse_demo_capabilities,
        run_biomedparse_demo,
    )
    from backend.server import app
except Exception:
    from biomedparse_demo import (  # type: ignore
        BiomedParseDemoRunRequest,
        biomedparse_demo_artifact_path,
        biomedparse_demo_capabilities,
        run_biomedparse_demo,
    )
    from server import app  # type: ignore


def configure_fake_worker(tmp_path: Path, monkeypatch) -> Path:
    root = tmp_path / "BiomedParse"
    (root / "configs" / "model").mkdir(parents=True)
    (root / "configs" / "model" / "biomedparse_3D.yaml").write_text("demo: true\n", encoding="utf-8")
    (root / "examples" / "imgs").mkdir(parents=True)
    (root / "examples" / "imgs" / "CT_AMOS_amos_0018.npz").write_bytes(b"fake-npz")
    checkpoint = root / "biomedparse_v2.ckpt"
    checkpoint.write_bytes(b"fake-checkpoint")
    runs_dir = tmp_path / "runs"
    worker = tmp_path / "fake_worker.py"
    worker.write_text(
        """
from __future__ import annotations
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--biomedparse-root")
parser.add_argument("--checkpoint")
parser.add_argument("--output-dir")
parser.add_argument("--source")
parser.add_argument("--slice-batch-size")
parser.add_argument("--prompt-ids")
args = parser.parse_args()
out = Path(args.output_dir)
out.mkdir(parents=True, exist_ok=True)
(out / "mask.npz").write_bytes(b"fake-mask")
(out / "preview.png").write_bytes(
    b"\\x89PNG\\r\\n\\x1a\\n\\x00\\x00\\x00\\rIHDR"
    b"\\x00\\x00\\x00\\x01\\x00\\x00\\x00\\x01\\x08\\x02\\x00\\x00\\x00"
    b"\\x90wS\\xde\\x00\\x00\\x00\\x00IEND\\xaeB`\\x82"
)
(out / "summary.json").write_text(json.dumps({
    "source": "included_ct_amos",
    "modelId": "microsoft/BiomedParse",
    "modelVersion": "fake-sha",
    "promptIds": [6],
    "inputShape": [63, 512, 512],
    "maskShape": [63, 512, 512],
    "nonzeroVoxels": 42,
    "previewSlice": 12,
    "labels": [{
        "label": 6,
        "prompt": "Visualization of the liver in abdominal CT imaging",
        "voxelCount": 42,
        "boundingBox": [10, 20, 30, 11, 21, 31],
        "color": "#a78bfa"
    }],
    "timings": {
        "modelInstantiatedSeconds": 1.0,
        "modelLoadedSeconds": 2.0,
        "inferenceSeconds": 3.0
    },
    "runtime": {
        "python": "3.12",
        "torchVersion": "fake",
        "torchCuda": "13.0",
        "device": "cuda",
        "gpuName": "Fake GPU",
        "peakVramGib": 8.279
    },
    "warnings": ["fake worker"]
}), encoding="utf-8")
""",
        encoding="utf-8",
    )

    monkeypatch.setenv("RADSYSX_BIOMEDPARSE_DEMO_ENABLED", "1")
    monkeypatch.setenv("RADSYSX_BIOMEDPARSE_PYTHON", sys.executable)
    monkeypatch.setenv("RADSYSX_BIOMEDPARSE_ROOT", str(root))
    monkeypatch.setenv("RADSYSX_BIOMEDPARSE_CKPT", str(checkpoint))
    monkeypatch.setenv("RADSYSX_BIOMEDPARSE_RUNS_DIR", str(runs_dir))
    monkeypatch.setenv("RADSYSX_BIOMEDPARSE_WORKER_SCRIPT", str(worker))
    return runs_dir


def test_biomedparse_demo_disabled_by_default(monkeypatch) -> None:
    monkeypatch.delenv("RADSYSX_BIOMEDPARSE_DEMO_ENABLED", raising=False)

    capabilities = biomedparse_demo_capabilities()

    assert capabilities.enabled is False
    assert capabilities.ready is False
    assert "RADSYSX_BIOMEDPARSE_DEMO_ENABLED" in str(capabilities.reason)


def test_biomedparse_demo_runs_fake_worker(tmp_path: Path, monkeypatch) -> None:
    configure_fake_worker(tmp_path, monkeypatch)

    capabilities = biomedparse_demo_capabilities()
    assert capabilities.enabled is True
    assert capabilities.ready is True

    response = asyncio.run(
        run_biomedparse_demo(
            BiomedParseDemoRunRequest(
                prompt_ids=[6],
                slice_batch_size=4,
                study_instance_uid="1.2.3",
            )
        )
    )

    assert response.status == "completed"
    assert response.model_id == "microsoft/BiomedParse"
    assert response.model_version == "fake-sha"
    assert response.study_instance_uid == "1.2.3"
    assert response.prompt_ids == [6]
    assert response.mask_shape == [63, 512, 512]
    assert response.nonzero_voxels == 42
    assert response.runtime.peak_vram_gib == 8.279
    assert response.artifacts.mask_npz_url.endswith(f"/{response.run_id}/mask.npz")
    assert biomedparse_demo_artifact_path(response.run_id, "mask.npz").is_file()
    assert biomedparse_demo_artifact_path(response.run_id, "preview.png").is_file()


def test_biomedparse_demo_routes_run_fake_worker(tmp_path: Path, monkeypatch) -> None:
    configure_fake_worker(tmp_path, monkeypatch)
    client = TestClient(app)
    login = client.post("/api/auth/local-login", json={"username": "demo-radiologist"})
    assert login.status_code == 200

    capabilities = client.get("/api/ai/biomedparse-demo/capabilities")
    assert capabilities.status_code == 200
    assert capabilities.json()["ready"] is True

    response = client.post(
        "/api/ai/biomedparse-demo/run",
        json={"source": "included_ct_amos", "promptIds": [6], "sliceBatchSize": 4},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert body["modelId"] == "microsoft/BiomedParse"
    assert body["promptIds"] == [6]
    assert body["nonzeroVoxels"] == 42
    assert body["artifacts"]["maskNpzUrl"].endswith(f"/{body['runId']}/mask.npz")
    assert body["artifacts"]["previewPngUrl"].endswith(f"/{body['runId']}/preview.png")


def test_biomedparse_demo_rejects_invalid_artifact_id(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("RADSYSX_BIOMEDPARSE_RUNS_DIR", str(tmp_path))

    try:
        biomedparse_demo_artifact_path("../escape", "mask.npz")
    except HTTPException as exc:
        assert exc.status_code == 400
    else:
        raise AssertionError("Expected invalid run id to be rejected.")
