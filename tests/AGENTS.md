# Root Tests DOX

## Purpose

- Own root-level test harnesses outside backend pytest suites.

## Ownership

- Owns `simple_server.py` and `test_client.py`.

## Local Contracts

- These scripts are legacy/lightweight harnesses and do not replace backend clinical pytest coverage.
- Do not make clinical validation depend only on these scripts.

## Work Guidance

- Keep scripts Linux-native and easy to run from the repository root.
- Prefer moving enduring backend behavior tests into `backend/tests`.

## Verification

- `python3 tests/simple_server.py`
- `python3 tests/test_client.py`

## Child DOX Index
