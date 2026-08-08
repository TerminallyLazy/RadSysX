# Deploy DOX

## Purpose

- Own deployment and local runtime configuration.

## Ownership

- Owns deploy-time folders and child stack configuration.

## Local Contracts

- Deployment docs and configs must preserve the clinical/research boundary and never normalize committed live credentials.
- Linux Docker Engine plus Compose is the reference local container runtime.

## Work Guidance

- Keep env-driven secrets explicit.
- Keep local clinical stack behavior aligned with root commands and docs.

## Verification

- `docker compose up --build`

## Child DOX Index

- `deploy/clinical-stack/AGENTS.md`: nginx, Orthanc, and config rendering for the one-origin clinical stack.
