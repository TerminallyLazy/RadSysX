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
