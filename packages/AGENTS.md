# Packages DOX

## Purpose

- Own workspace packages shared by RadSysX app surfaces.

## Ownership

- Owns package-level workspace structure under `packages/*`.

## Local Contracts

- Shared packages should carry code that is genuinely reused across surfaces.
- Do not hide clinical authority in browser packages; browser packages model contracts and clients, while the backend enforces policy.

## Work Guidance

- Keep package exports explicit.
- Keep package source aligned with root npm workspace and lockfile.

## Verification

- `npm run type-check --workspace frontend`
- `npm run type-check --workspace viewer`

## Child DOX Index

- `packages/clinical-web/AGENTS.md`: shared clinical browser contracts, client, and env helpers.
