# Backend Tests DOX

## Purpose

- Own backend pytest coverage.

## Ownership

- Owns clinical platform tests and research/model validation tests under `backend/tests`.

## Local Contracts

- Clinical tests should exercise backend-authoritative contracts rather than browser-local state.
- Tests must not depend on committed local databases, live PHI, or machine-local dependency paths.
- Use fixtures and synthetic/de-identified data.

## Work Guidance

- Prefer focused tests near the contract being changed.
- Expand coverage when touching shared clinical contracts, launch/session behavior, audit, DICOMweb, or persistence.

## Verification

- `python3 -m pytest backend/tests/test_clinical_platform.py`
- `python3 -m pytest backend/tests`

## Child DOX Index
