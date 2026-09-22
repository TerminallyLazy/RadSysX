# Backend Tools DOX

## Purpose

- Own research agent helper tools for medication, medical information, and literature workflows.

## Ownership

- Owns `medical_info.py`, `medications.py`, and `researcher.py`.

## Local Contracts

- These tools support the research/agent backend and must not be used as clinical authority.
- Network-backed medical and literature lookups should make provenance and limitations clear.
- Do not log or persist patient identifiers through these tools.

## Work Guidance

- Keep tool inputs/outputs stable for `backend/radsysx.py` agent integration.
- Prefer explicit errors over silent degraded medical claims.

## Verification

## Child DOX Index

- `accept_jev_sidebar.py` is an explicit `--allow-live` acceptance utility, not an agent tool. It resolves only the TypeSafe key from the explicitly requested env file/environment, composes the normal signed-owner router/service against disposable isolated persistence, and sends one fixed synthetic claim to the real TypeSafe transport. NCBI is a clearly labeled synthetic source; no voice, patient history or other provider is used. Refuse before secrets/network without opt-in. Retain sanitized owner-only receipts under ignored `tmp/jev-sidebar-acceptance/`; delete its temporary database/artifacts after each run.
