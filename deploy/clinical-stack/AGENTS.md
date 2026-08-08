# Clinical Stack Deploy DOX

## Purpose

- Own nginx and Orthanc configuration for the local one-origin clinical stack.

## Ownership

- Owns `nginx.conf`, `orthanc.json`, and `render-orthanc-config.sh`.

## Local Contracts

- Public clinical origin is `http://localhost:3000`.
- nginx routes `/api/` to FastAPI, `/viewer/` to the viewer app, `/dicom-web/` to Orthanc, and `/` to the Next.js shell.
- Orthanc credentials must come from environment variables and must not be committed as live secrets.
- DICOMweb paths must stay same-origin for governed viewer flow.

## Work Guidance

- Keep proxy headers compatible with backend audit/source IP expectations.
- Keep Orthanc config template placeholders in sync with the render script and compose env vars.

## Verification

- `docker compose up --build`

## Child DOX Index
