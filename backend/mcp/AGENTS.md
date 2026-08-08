# Backend MCP DOX

## Purpose

- Own research-oriented Model Context Protocol integration, especially FHIR access for the agent stack.

## Ownership

- Owns `agent_integration.py`, `client.py`, `fhir_server.py`, `installer.py`, and `README.md`.

## Local Contracts

- MCP/FHIR integration is research/agent infrastructure, not the governed clinical data authority.
- Do not use MCP as a shortcut around clinical contracts, actor identity, audit, DICOMweb, or reporting APIs.
- FHIR configuration is env-driven through values such as `FHIR_BASE_URL` and `FHIR_ACCESS_TOKEN`.
- Treat FHIR payloads and patient identifiers as sensitive; do not log them casually.

## Work Guidance

- Keep client/server/toolkit boundaries clear.
- Preserve graceful unavailability behavior where optional MCP dependencies are absent.
- Keep examples and README guidance aligned with executable scripts.

## Verification

- `python3 backend/test_mcp_integration.py`

## Child DOX Index
