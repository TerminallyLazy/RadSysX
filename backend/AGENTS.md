# Backend DOX

## Purpose

- Own the Python backend surfaces for RadSysX.
- Keep the governed clinical FastAPI platform separate from the research/agent backend and optional MCP/BiomedParse seams.

## Ownership

- Owns `backend/server.py`, `backend/main.py`, Python requirements, backend package initialization, `backend/langgraph.json`, research backend modules, and local backend runtime artifacts.
- `backend/radsysx_clinical.db` is a local dev artifact and must not be committed.
- Child docs own clinical platform code, MCP integration, model utilities, skills, backend tests, and research tool modules.

## Local Contracts

- `backend/server.py` is the FastAPI entrypoint and may gracefully degrade optional research imports, but new clinical behavior must route through `backend/clinical/*`.
- The clinical service layer is authoritative for governed workflow, actor identity, audit, DICOMweb, reports, AI jobs, and derived results.
- Research modules such as `backend/radsysx.py`, `backend/chat_interface.py`, `backend/biomedparse_api.py`, `backend/biomedparse_api_simple.py`, `backend/biomedparse_demo.py`, and `backend/biomedparse_demo_worker.py` must not become clinical shortcuts.
- `backend/biomedparse_demo.py` is a lightweight optional integration demo router/helper. It may expose capabilities and spawn a configured external BioMedParse worker, but it must not import CUDA, Detectron2, or BioMedParse dependencies into the clinical FastAPI process at import time.
- `backend/biomedparse_demo_worker.py` is the subprocess worker entrypoint for the demo. It assumes a separately prepared BioMedParse checkout, Python environment, and checkpoint path supplied through environment variables.
- Keep dependency guidance split: `requirements-clinical.txt` for clinical runtime, `requirements.txt` for broader research/agent runtime.

## Work Guidance

- Use async endpoints for I/O boundaries.
- Keep clinical request/response schema in contracts, orchestration in services, persistence in repositories, and archive access behind adapters.
- Avoid ad hoc `PYTHONPATH` or machine-local dependency shims; make imports and requirements reproducible.
- Do not casually log PHI, DICOM tags, FHIR payloads, launch context, or identifiers.

## Verification

- `python3 -m pytest backend/tests/test_clinical_platform.py`
- `python3 -m compileall backend/clinical backend/server.py backend/radsysx.py`

## Child DOX Index

- `backend/clinical/AGENTS.md`: governed clinical platform implementation.
- `backend/mcp/AGENTS.md`: research MCP/FHIR integration.
- `backend/models_utils/AGENTS.md`: optional model/GPU utility materials.
- `backend/skills/AGENTS.md`: research agent skill prompts.
- `backend/tests/AGENTS.md`: backend pytest suites.
- `backend/tools/AGENTS.md`: research agent tools.
