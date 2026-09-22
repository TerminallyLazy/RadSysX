# Backend Skills DOX

## Purpose

- Own research agent skill prompt files used by the backend agent stack.

## Ownership

- Owns `*/SKILL.md` files under `backend/skills`.

## Local Contracts

- Skills are research/agent instructions and are not governed clinical workflow contracts.
- Do not use skill prompts to weaken root safety, PHI, or clinical separation rules.
- Keep prompts concise and aligned with the tools that actually exist in `backend/tools` and `backend/mcp`.

## Work Guidance

- Update a skill when changing the durable capability, expected inputs, output shape, or tool assumptions for that agent role.
- Keep medical wording conservative and evidence-oriented.

## Verification

## Child DOX Index

## Script privacy

- DICOM anonymization scripts report field names and actions only, including verbose mode. Do not print original/replacement patient values, input/output paths, or exception text that may contain identifiers.
