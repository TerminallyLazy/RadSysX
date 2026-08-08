# Frontend Libraries DOX

## Purpose

- Own frontend clients, env helpers, services, hooks, types, and utilities.

## Ownership

- Owns `api.ts`, `clinical/`, `cornerstone/`, `hooks/`, `server/`, `services/`, `types/`, `utils/`, `db.ts`, `env.ts`, and toast helpers.

## Local Contracts

- `clinical/client.ts` and `clinical/contracts.ts` are thin re-exports from `@radsysx/clinical-web`.
- Shared clinical browser contracts belong in `packages/clinical-web`, not duplicated here.
- `env.ts` owns frontend-facing mode helpers and research-only Gemini key access.
- Research API helpers must not become governed clinical clients.

## Work Guidance

- Prefer the shared clinical package for any type/client used by both Next.js and OHIF.
- Keep server-only helpers out of browser bundles.
- Maintain mode gating for experimental imaging features.

## Verification

- `npm run type-check --workspace frontend`

## Child DOX Index
