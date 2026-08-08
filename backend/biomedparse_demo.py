from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from fastapi import HTTPException
from pydantic import Field

try:
    from backend.clinical.contracts import ClinicalModel
except ModuleNotFoundError:
    from clinical.contracts import ClinicalModel


DEMO_MODEL_ID = "microsoft/BiomedParse"
DEMO_MODEL_LICENSE = "cc-by-nc-sa-4.0"
DEMO_SOURCE = "included_ct_amos"
RUN_ID_PATTERN = re.compile(r"^bmp-[0-9a-f]{32}$")


class BiomedParseDemoCapabilities(ClinicalModel):
    enabled: bool
    ready: bool
    reason: str | None = None
    model_id: str = Field(default=DEMO_MODEL_ID, alias="modelId")
    license: str = DEMO_MODEL_LICENSE
    source: Literal["included_ct_amos"] = DEMO_SOURCE
    supported_prompt_ids: list[int] = Field(default_factory=lambda: list(range(1, 16)), alias="supportedPromptIds")
    default_prompt_ids: list[int] = Field(default_factory=list, alias="defaultPromptIds")
    research_only: bool = Field(default=True, alias="researchOnly")
    output_note: str = Field(
        default="Preview NPZ/PNG artifacts only; no DICOM SEG persistence or clinical coordinate mapping.",
        alias="outputNote",
    )


class BiomedParseDemoRunRequest(ClinicalModel):
    source: Literal["included_ct_amos"] = DEMO_SOURCE
    prompt_ids: list[int] = Field(default_factory=list, alias="promptIds")
    slice_batch_size: int = Field(default=4, ge=1, le=16, alias="sliceBatchSize")
    study_instance_uid: str | None = Field(default=None, alias="studyInstanceUID")
    trace_id: str | None = None


class BiomedParseDemoLabelSummary(ClinicalModel):
    label: int
    prompt: str
    voxel_count: int = Field(alias="voxelCount")
    bounding_box: list[int] | None = Field(default=None, alias="boundingBox")
    color: str


class BiomedParseDemoTiming(ClinicalModel):
    model_instantiated_seconds: float | None = Field(default=None, alias="modelInstantiatedSeconds")
    model_loaded_seconds: float | None = Field(default=None, alias="modelLoadedSeconds")
    inference_seconds: float | None = Field(default=None, alias="inferenceSeconds")


class BiomedParseDemoRuntime(ClinicalModel):
    python: str | None = None
    torch_version: str | None = Field(default=None, alias="torchVersion")
    torch_cuda: str | None = Field(default=None, alias="torchCuda")
    device: str | None = None
    gpu_name: str | None = Field(default=None, alias="gpuName")
    peak_vram_gib: float | None = Field(default=None, alias="peakVramGib")


class BiomedParseDemoArtifacts(ClinicalModel):
    mask_npz_url: str = Field(alias="maskNpzUrl")
    preview_png_url: str = Field(alias="previewPngUrl")


class BiomedParseDemoRunResponse(ClinicalModel):
    status: Literal["completed"]
    run_id: str = Field(alias="runId")
    source: Literal["included_ct_amos"]
    model_id: str = Field(alias="modelId")
    model_version: str = Field(alias="modelVersion")
    license: str
    prompt_ids: list[int] = Field(alias="promptIds")
    input_shape: list[int] = Field(alias="inputShape")
    mask_shape: list[int] = Field(alias="maskShape")
    nonzero_voxels: int = Field(alias="nonzeroVoxels")
    preview_slice: int = Field(alias="previewSlice")
    labels: list[BiomedParseDemoLabelSummary]
    timings: BiomedParseDemoTiming
    runtime: BiomedParseDemoRuntime
    artifacts: BiomedParseDemoArtifacts
    warnings: list[str] = Field(default_factory=list)
    study_instance_uid: str | None = Field(default=None, alias="studyInstanceUID")
    trace_id: str | None = None


def biomedparse_demo_capabilities() -> BiomedParseDemoCapabilities:
    enabled = _read_bool("RADSYSX_BIOMEDPARSE_DEMO_ENABLED", False)
    if not enabled:
        return BiomedParseDemoCapabilities(
            enabled=False,
            ready=False,
            reason="Set RADSYSX_BIOMEDPARSE_DEMO_ENABLED=1 to enable the research demo.",
        )

    missing = _missing_configuration()
    return BiomedParseDemoCapabilities(
        enabled=True,
        ready=not missing,
        reason="; ".join(missing) if missing else None,
    )


async def run_biomedparse_demo(request: BiomedParseDemoRunRequest) -> BiomedParseDemoRunResponse:
    capabilities = biomedparse_demo_capabilities()
    if not capabilities.enabled:
        raise HTTPException(status_code=404, detail=capabilities.reason or "BioMedParse demo is disabled.")
    if not capabilities.ready:
        raise HTTPException(status_code=409, detail=capabilities.reason or "BioMedParse demo is not ready.")

    run_id = f"bmp-{uuid4().hex}"
    run_dir = _runs_dir() / run_id
    run_dir.mkdir(parents=True, exist_ok=False)

    request_path = run_dir / "request.json"
    request_path.write_text(json.dumps(request.model_dump(by_alias=True), indent=2), encoding="utf-8")

    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    root = _biomedparse_root()
    env["PYTHONPATH"] = _prepend_path(str(root), env.get("PYTHONPATH"))

    command = [
        _worker_python(),
        str(_worker_script()),
        "--biomedparse-root",
        str(root),
        "--checkpoint",
        str(_checkpoint_path()),
        "--output-dir",
        str(run_dir),
        "--source",
        request.source,
        "--slice-batch-size",
        str(request.slice_batch_size),
        "--prompt-ids",
        ",".join(str(prompt_id) for prompt_id in request.prompt_ids),
    ]

    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(root),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=_timeout_seconds())
    except asyncio.TimeoutError as exc:
        process.kill()
        await process.communicate()
        raise HTTPException(status_code=504, detail="BioMedParse demo timed out.") from exc

    (run_dir / "stdout.log").write_bytes(stdout)
    (run_dir / "stderr.log").write_bytes(stderr)

    if process.returncode != 0:
        detail = _tail_text(stderr) or _tail_text(stdout) or "BioMedParse worker failed."
        raise HTTPException(status_code=502, detail=detail)

    summary_path = run_dir / "summary.json"
    if not summary_path.is_file():
        raise HTTPException(status_code=502, detail="BioMedParse worker did not produce summary.json.")

    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    mask_path = run_dir / "mask.npz"
    preview_path = run_dir / "preview.png"
    if not mask_path.is_file() or not preview_path.is_file():
        raise HTTPException(status_code=502, detail="BioMedParse worker did not produce expected artifacts.")

    return _response_from_summary(
        run_id=run_id,
        request=request,
        summary=summary,
    )


def biomedparse_demo_artifact_path(run_id: str, filename: Literal["mask.npz", "preview.png"]) -> Path:
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise HTTPException(status_code=400, detail="Invalid BioMedParse demo run id.")
    path = (_runs_dir() / run_id / filename).resolve()
    runs_root = _runs_dir().resolve()
    if path.parent.parent != runs_root:
        raise HTTPException(status_code=403, detail="BioMedParse demo artifact path is outside the runs directory.")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="BioMedParse demo artifact was not found.")
    return path


def biomedparse_demo_input_hash(request: BiomedParseDemoRunRequest) -> str:
    digest = hashlib.sha256(
        json.dumps(request.model_dump(by_alias=True), sort_keys=True).encode("utf-8"),
    ).hexdigest()
    return f"biomedparse-demo:{digest[:24]}"


def _response_from_summary(
    *,
    run_id: str,
    request: BiomedParseDemoRunRequest,
    summary: dict[str, Any],
) -> BiomedParseDemoRunResponse:
    return BiomedParseDemoRunResponse(
        status="completed",
        run_id=run_id,
        source=DEMO_SOURCE,
        model_id=str(summary.get("modelId") or DEMO_MODEL_ID),
        model_version=str(summary.get("modelVersion") or "unknown"),
        license=DEMO_MODEL_LICENSE,
        prompt_ids=[int(value) for value in summary.get("promptIds", [])],
        input_shape=[int(value) for value in summary.get("inputShape", [])],
        mask_shape=[int(value) for value in summary.get("maskShape", [])],
        nonzero_voxels=int(summary.get("nonzeroVoxels") or 0),
        preview_slice=int(summary.get("previewSlice") or 0),
        labels=[
            BiomedParseDemoLabelSummary(
                label=int(label.get("label")),
                prompt=str(label.get("prompt") or ""),
                voxel_count=int(label.get("voxelCount") or 0),
                bounding_box=(
                    [int(value) for value in label["boundingBox"]]
                    if label.get("boundingBox") is not None
                    else None
                ),
                color=str(label.get("color") or "#67e8f9"),
            )
            for label in summary.get("labels", [])
        ],
        timings=BiomedParseDemoTiming(**dict(summary.get("timings") or {})),
        runtime=BiomedParseDemoRuntime(**dict(summary.get("runtime") or {})),
        artifacts=BiomedParseDemoArtifacts(
            mask_npz_url=f"/api/ai/biomedparse-demo/runs/{run_id}/mask.npz",
            preview_png_url=f"/api/ai/biomedparse-demo/runs/{run_id}/preview.png",
        ),
        warnings=[str(warning) for warning in summary.get("warnings", [])],
        study_instance_uid=request.study_instance_uid,
        trace_id=request.trace_id,
    )


def _missing_configuration() -> list[str]:
    missing: list[str] = []
    worker_python = _worker_python()
    root = _biomedparse_root()
    checkpoint = _checkpoint_path()
    worker_script = _worker_script()

    if not Path(worker_python).is_file():
        missing.append("RADSYSX_BIOMEDPARSE_PYTHON does not point to a Python executable")
    if not root.is_dir():
        missing.append("RADSYSX_BIOMEDPARSE_ROOT does not point to a BioMedParse checkout")
    if not (root / "configs" / "model" / "biomedparse_3D.yaml").is_file():
        missing.append("BioMedParse v2 config was not found under RADSYSX_BIOMEDPARSE_ROOT")
    if not (root / "examples" / "imgs" / "CT_AMOS_amos_0018.npz").is_file():
        missing.append("BioMedParse bundled CT AMOS example was not found")
    if not checkpoint.is_file():
        missing.append("RADSYSX_BIOMEDPARSE_CKPT does not point to biomedparse_v2.ckpt")
    if not worker_script.is_file():
        missing.append("RADSYSX_BIOMEDPARSE_WORKER_SCRIPT was not found")
    return missing


def _worker_python() -> str:
    return os.getenv("RADSYSX_BIOMEDPARSE_PYTHON", sys.executable)


def _biomedparse_root() -> Path:
    return Path(os.getenv("RADSYSX_BIOMEDPARSE_ROOT", "/tmp/BiomedParse")).expanduser()


def _checkpoint_path() -> Path:
    return Path(os.getenv("RADSYSX_BIOMEDPARSE_CKPT", "")).expanduser()


def _worker_script() -> Path:
    return Path(
        os.getenv(
            "RADSYSX_BIOMEDPARSE_WORKER_SCRIPT",
            str(Path(__file__).with_name("biomedparse_demo_worker.py")),
        )
    ).expanduser()


def _runs_dir() -> Path:
    configured = os.getenv("RADSYSX_BIOMEDPARSE_RUNS_DIR")
    if configured:
        path = Path(configured).expanduser()
    else:
        path = Path(__file__).resolve().parent / "tmp" / "biomedparse-demo"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _timeout_seconds() -> float:
    raw = os.getenv("RADSYSX_BIOMEDPARSE_TIMEOUT_SECONDS", "180")
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 180.0


def _read_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _prepend_path(path: str, current: str | None) -> str:
    if not current:
        return path
    return f"{path}{os.pathsep}{current}"


def _tail_text(payload: bytes, limit: int = 4000) -> str:
    text = payload.decode("utf-8", errors="replace").strip()
    if len(text) <= limit:
        return text
    return text[-limit:]
