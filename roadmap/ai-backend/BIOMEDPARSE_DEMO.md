# RadSysX BioMedParse Integration Demo

Last updated: 2026-06-13
Status: implemented as an opt-in research/demo integration; not a clinical segmentation workflow.

## Purpose

This runbook explains how to run the first RadSysX integration demo for BioMedParse v2.

The demo proves this path:

1. RadSysX FastAPI exposes a session-protected capability endpoint.
2. The worklist UI shows a BioMedParse demo panel only when the backend says it is enabled.
3. The backend spawns a separate BioMedParse Python worker instead of importing CUDA/Detectron2 into the clinical app process.
4. The worker runs the verified bundled CT AMOS example.
5. The backend returns normalized preview artifacts:
   - `mask.npz`
   - `preview.png`
   - label/voxel/timing/runtime metadata

It does not yet:

- Run on a user-selected RadSysX study.
- Map masks into OHIF image space.
- Persist DICOM SEG.
- Claim clinical validity.

## Files

- `backend/biomedparse_demo.py`
  - Lightweight capability/run/artifact helper used by FastAPI.
- `backend/biomedparse_demo_worker.py`
  - Heavy subprocess worker entrypoint. Imports BioMedParse only inside the worker environment.
- `backend/server.py`
  - Exposes `/api/ai/biomedparse-demo/*` routes.
- `packages/clinical-web/src/contracts.ts`
  - Shared TypeScript contract types.
- `packages/clinical-web/src/client.ts`
  - Shared browser client calls.
- `frontend/app/worklist/page.tsx`
  - Optional demo panel shown only when enabled.
- `backend/tests/test_biomedparse_demo.py`
  - Fake-worker tests that do not require CUDA or BioMedParse.

## GPU VM Environment

The successful BioMedParse smoke used:

- BioMedParse checkout: `/tmp/BiomedParse`
- Worker venv: `/tmp/BiomedParse/.venv-cu130`
- Checkpoint: `biomedparse_v2.ckpt` under the RadSysX Hugging Face cache
- GPU: NVIDIA L40S
- PyTorch lane: CUDA 13 aligned

The Hugging Face token was removed from the VM cache after the smoke. Do not re-add a token unless another gated download is explicitly needed.

Find the cached checkpoint path:

```bash
find "$HOME/.cache/radsysx/models/huggingface/hub/models--microsoft--BiomedParse" \
  -path "*/snapshots/*/biomedparse_v2.ckpt" \( -type l -o -type f \)
```

## Run The Demo Backend

From `/home/eclypso/a0/RadSysX` on the GPU VM:

```bash
export RADSYSX_APP_MODE=research
export RADSYSX_SESSION_COOKIE_SECURE=false
export RADSYSX_LOCAL_IMAGING_ENABLED=1
export RADSYSX_BIOMEDPARSE_DEMO_ENABLED=1
export RADSYSX_BIOMEDPARSE_ROOT=/tmp/BiomedParse
export RADSYSX_BIOMEDPARSE_PYTHON=/tmp/BiomedParse/.venv-cu130/bin/python
export RADSYSX_BIOMEDPARSE_CKPT="$HOME/.cache/radsysx/models/huggingface/hub/models--microsoft--BiomedParse/snapshots/e473e5b2b1a3f44649734afd3dc7cf1770aaa9e2/biomedparse_v2.ckpt"
export RADSYSX_BIOMEDPARSE_TIMEOUT_SECONDS=180

. .venv/bin/activate
python3 backend/server.py
```

In a second shell, authenticate and run the endpoint:

```bash
curl -sS -c /tmp/radsysx-demo.cookies \
  -H "Content-Type: application/json" \
  -d '{"username":"demo-radiologist"}' \
  http://127.0.0.1:8000/api/auth/local-login >/tmp/radsysx-login.json

curl -sS -b /tmp/radsysx-demo.cookies \
  http://127.0.0.1:8000/api/ai/biomedparse-demo/capabilities | python3 -m json.tool

curl -sS -b /tmp/radsysx-demo.cookies \
  -H "Content-Type: application/json" \
  -d '{"source":"included_ct_amos","sliceBatchSize":4}' \
  http://127.0.0.1:8000/api/ai/biomedparse-demo/run | python3 -m json.tool
```

Open `/worklist` through the normal frontend/Electron path to see the optional panel when the backend capability endpoint is enabled.

## Expected Result

The run response should include:

- `status: "completed"`
- `modelId: "microsoft/BiomedParse"`
- `license: "cc-by-nc-sa-4.0"`
- `maskShape: [63, 512, 512]`
- `nonzeroVoxels` greater than `0`
- `artifacts.maskNpzUrl`
- `artifacts.previewPngUrl`
- runtime metrics including `peakVramGib`

Artifacts are written under:

```text
backend/tmp/biomedparse-demo/<run-id>/
```

This directory is a local runtime artifact and must not be committed.

## Guardrails

- Keep `RADSYSX_BIOMEDPARSE_DEMO_ENABLED` off by default.
- Do not add BioMedParse dependencies to `backend/requirements-clinical.txt`.
- Do not commit checkpoints, generated masks, preview images, logs, or Hugging Face tokens.
- Do not call this a clinical segmentation until coordinate mapping, DICOM SEG conversion, user approval, validation, and governance are implemented.
- Do not send PHI-bearing image context to external APIs from this path.

## Next Steps

- Add a local-study source that reads an imported RadSysX NIFTI/NPZ asset through a safe backend asset reference.
- Normalize the mask output into a `SegmentationResult` DTO.
- Add OHIF preview-only overlay integration.
- Add coordinate round-trip tests before any persistence.
- Add backend-mediated DICOM SEG writeback only after preview/user approval is working.
