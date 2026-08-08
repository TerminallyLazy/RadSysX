# RadSysX Local Development Guide

## Fast Local Desktop Path

For the shortest no-Docker local run of RadSysX, use the Electron desktop path from the repo root:

```bash
npm run desktop
```

This starts the local clinical FastAPI backend, a production Next.js standalone shell, and OHIF viewer bridge under one localhost origin. Electron opens directly to OHIF's native local DICOM loader at `/viewer/local`; DICOM files load into OHIF through `dicomlocal` without a governed launch token, while non-DICOM-only imports remain available through worklist inspection. The visible app title stays `RadSysX`, and the OHIF right sidebar includes a frontend-only RadSysX AI chat tab with text, voice-input affordance, and `@` ROI/segmentation/measurement context chips. It is the preferred quick path for local login, native local file/folder selection with direct Electron-main upload to the backend, browser drag-and-drop import, local DICOM/DICOMDIR/NIFTI `.nii`/`.nii.gz`/paired `.hdr+.img`/NRRD `.nrrd`/ZIP archive import including extensionless and multi-study DICOMDIR companion files, imported-study asset summaries, backend-mediated axial/coronal/sagittal NIFTI slice previews, common image previews including PNG/JPEG byte previews and TIFF SVG header previews, NRRD header/voxel metrics, deterministic technical analysis, NIFTI header inspection, worklist registration, local DICOM metadata/frame serving, launch/session, workspace, report, AI job, and audit contract work. Full Orthanc-backed DICOMweb retrieval, full NIFTI/NRRD volume rendering, full TIFF pixel decoding, and durable STOW validation still require deeper validation or a configured local imaging backend.

`RADSYSX_DESKTOP_START_PATH` can override the first route for focused validation, but normal local use should keep the default `/viewer/local` so OHIF local mode is the first screen.

The desktop launcher first checks the local bootstrap, runs `npm run desktop:bootstrap` if setup is incomplete, then builds and stamps the frontend production shell when needed. The default public frontend API/viewer settings are same-origin, so the local app can reuse the same build if it chooses a fallback localhost port. Use `RADSYSX_DESKTOP_REBUILD_FRONTEND=1 npm run desktop` to force a rebuild, or `npm run desktop:dev-frontend` when intentionally developing against the Next.js dev server.

`npm run desktop:bootstrap` is a cross-platform Node bootstrap helper. It creates or reuses `.venv`, installs the clinical Python dependency set with the venv Python, runs workspace `npm install --legacy-peer-deps`, and then runs desktop doctor. Use `npm run desktop -- --check-only` or `npm run desktop:bootstrap -- --check` to verify an existing bootstrap without reinstalling dependencies. Use `npm run desktop:run` only when intentionally bypassing the user-facing setup check after setup is known good.

The desktop runtime, doctor, bootstrap, and smoke helpers use the platform-correct venv Python path (`.venv/bin/python` on Unix-like hosts, `.venv/Scripts/python.exe` on Windows). Set `RADSYSX_DESKTOP_PYTHON=/path/to/python` if a machine needs an explicit interpreter override.

For focused validation of the launcher and local imaging path, use:

```bash
npm run desktop -- --check-only
npm run desktop:doctor
npm run desktop:smoke:launch
npm run desktop:smoke
npm run desktop:smoke:local-start
npm run desktop:smoke:local-start-drop
npm run desktop:smoke:local-start-nondicom
npm run desktop:smoke:import
npm run desktop:smoke:ui-import
npm run desktop:smoke:picker-files-import
npm run desktop:smoke:picker-import
npm run desktop:smoke:picker-large-import
npm run desktop:smoke:picker-many-import
npm run desktop:smoke:viewer-launch
```

`npm run desktop:smoke:launch` runs the same user-facing launcher path as `npm run desktop`: bootstrap check first, then service-ready Electron startup with the OHIF-first default retained, using a short cross-platform auto-shutdown timer. `npm run desktop:smoke:local-start` is the UI assertion that samples `/viewer/local`, confirms no RadSysX intermediate card or governed launch is present, and verifies local-DICOM OHIF rendering.

`npm run desktop:smoke:local-start` starts Electron at `/viewer/local`, verifies OHIF's local file/folder controls are visible without a RadSysX bootstrap card, verifies the document title is `RadSysX`, loads a synthetic DICOM through OHIF's local file input, routes to `/viewer/dicomlocal?datasources=dicomlocal`, and asserts that OHIF paints a nonblank canvas with the RadSysX AI sidebar composer available, without a governed launch.

`npm run desktop:smoke:local-start-drop` starts Electron at the same OHIF local screen, drops a synthetic DICOM directly onto it, forwards the drop into OHIF's local file input, routes to `/viewer/dicomlocal?datasources=dicomlocal`, and asserts that OHIF paints a nonblank canvas with the `RadSysX` title and RadSysX AI sidebar composer, without a governed launch.

`npm run desktop:smoke:local-start-nondicom` starts from the same OHIF local screen, then verifies NIFTI/NRRD/image/ZIP fixtures remain usable through `/worklist` local asset inspection, preview loading, NIFTI slice-axis switching, backend technical analysis, and no OHIF viewer action for the non-DICOM row.

`npm run desktop:smoke:import` starts the desktop runtime on high local ports, creates PHI-free synthetic DICOMDIR/DICOM/NIFTI `.nii`/`.nii.gz`/paired `.hdr+.img`, NRRD `.nrrd`, ZIP with supported NIFTI/PNG members, plus PNG/JPEG/TIFF files, imports them through the local bridge, verifies worklist, local DICOMweb, asset-summary, preview, analysis, and launch behavior, and shuts the runtime down.

`npm run desktop:smoke:ui-import` drives the hydrated Electron worklist UI, drops the same class of synthetic local imaging files onto the local import panel, verifies inspection, NIFTI slice preview controls, and backend technical analysis, and shuts the runtime down.

`npm run desktop:smoke:picker-files-import` drives the hydrated Electron worklist `Import files` action through the preload IPC/native picker bridge with smoke-injected individual fixture file paths, uploads selected files from Electron main to the backend import endpoint with the existing session cookie, verifies the same import, inspection, preview, and analysis behavior, and shuts the runtime down. It proves the file picker bridge path without replacing a real native OS-dialog smoke.

`npm run desktop:smoke:picker-import` drives the hydrated Electron worklist `Import folder` action through the preload IPC/native picker bridge with smoke-injected fixture paths, uploads selected files from Electron main to the backend import endpoint with the existing session cookie, verifies the same import, inspection, preview, and analysis behavior, and shuts the runtime down. It proves the folder picker bridge path without replacing a real native OS-dialog smoke.

`npm run desktop:smoke:picker-large-import` repeats that direct native picker path with an additional 8 MiB synthetic NIFTI volume and verifies backend asset summary, preview, and technical analysis for the larger payload.

`npm run desktop:smoke:picker-many-import` repeats that direct native picker path with a nested folder of 32 additional extensionless DICOM instances and verifies recursive collection, import of 44 accepted files after ZIP expansion into 2 local studies, DICOM asset summary, and backend technical analysis.

`npm run desktop:smoke:viewer-launch` imports synthetic local DICOM/DICOMDIR data through the hydrated worklist, opens the governed viewer, verifies opaque launch resolution and launch-token stripping, checks viewer-origin local DICOMweb/workspace access to the imported study, and asserts that OHIF paints a nonblank canvas for the synthetic DICOM. It proves viewer handoff, local DICOMweb binding, and a basic imported-DICOM render path without claiming full diagnostic pixel-rendering parity across real-world archives.

## Frontend Local, GPU Backend On Cloud VM

This guide explains how to run RadSysX locally while using a remote GPU VM for the BiomedParse backend, mirroring production for the model service.

## Topology
- Backend (GPU): runs on a cloud VM exactly as in production (see `DEPLOY_GPU.md`).
- Frontend (local): runs Next.js dev server on your workstation and calls the remote backend via `NEXT_PUBLIC_BP_API_BASE`.

## Prerequisites
- A running GPU VM with the backend deployed as described in `DEPLOY_GPU.md` (port 8000 open to your IP or VPN/subnet).
- Your workstation with Node.js 18+ (or current LTS) and a package manager (npm or pnpm).
- Optional but recommended: Git, curl.

## Step 1 — Start the GPU Backend (on the VM)
Follow `DEPLOY_GPU.md` to:
1. Build the Docker image with CUDA.
2. Run the container with `--gpus all`, mount your checkpoint, and expose `:8000`.
3. Verify:
```bash
curl http://<VM_IP>:8000/api/biomedparse/v1/health
```
Expect `{ "status": "healthy", "gpu_available": true }`.

## Step 2 — Configure the Frontend to point to the VM
Create a `.env.local` file under `frontend/` with the remote API base of your VM:

```ini
# Frontend (Next.js) reads this at build/runtime in dev
NEXT_PUBLIC_BP_API_BASE=http://<VM_IP>:8000/api/biomedparse/v1
```

Notes:
- If `NEXT_PUBLIC_BP_API_BASE` is not set, the frontend will attempt to call a local backend at `/api/biomedparse/v1`. For local development with a remote GPU backend, you must set this variable.
- Ensure firewall/security groups allow access from your workstation to the VM’s `:8000`.
- If you containerize the frontend with Docker, rename `.env.local` to `.env` (or copy its contents) so it can be loaded by the container (e.g., with `--env-file frontend/.env`).
- On your local OS firewall, allow outbound to the VM and inbound to `localhost:3000` if restricted; on the cloud side, open TCP port `8000` to your IP only.

## Step 3 — Run the Frontend locally
From the repository root:

```bash
cd frontend
npm install
npm run dev
```

Then open your browser at `http://localhost:3000`.

## Step 4 — End‑to‑End Smoke Test (UI)
1. In the Right Panel, upload an image (2D) or a NIfTI volume (3D `.nii`/`.nii.gz`).
2. Enter one or more prompts (e.g., `liver, tumor`).
3. Toggle “Return heatmap” (optional) and adjust threshold/`slice_batch_size` if needed.
4. Click “Analyze with BiomedParse”.
5. For 3D results, you will see `mask_url`/`heatmap_url`. Use the provided buttons to apply Labelmap or Heatmap overlays. Opacity can be adjusted for heatmaps.

## Troubleshooting
- Cannot reach backend: check that `NEXT_PUBLIC_BP_API_BASE` points to `http://<VM_IP>:8000/api/biomedparse/v1` and that the VM firewall allows your client IP.
- CORS errors: backend dev config allows all origins by default (see `backend/server.py`). If you changed it, permit `http://localhost:3000`.
- OOM on backend: lower `BP_SLICE_BATCH_SIZE` (env) or pass `?slice_batch_size=` in 3D requests from UI.
- Missing checkpoint: ensure the VM container has `BP3D_CKPT` pointing to a valid path (mounted with `-v`).
- Heatmap validation failures: keep `BP_VALIDATE_HEATMAP=1` and ensure NPZ contains `prob` as `uint8`.

## Optional — Local Backend proxy
If you prefer, you can also run the backend locally (CPU-only will be slow) or create a small local proxy that forwards `/api/biomedparse/v1/*` to the VM. This is not required; the recommended flow is to point the frontend directly to the VM via `NEXT_PUBLIC_BP_API_BASE`.
