# Frontend API Routes DOX

## Purpose

- Own Next.js API route handlers used by research-only prototype flows.

## Ownership

- Owns `analyze/route.ts` and `upload/route.ts`.

## Local Contracts

- These routes are disabled outside `research` mode.
- Do not make these routes part of the `pilot` or `clinical` workflow.
- Do not write clinical uploads into public static paths.
- Do not use browser-originated uploads here as a governed archive ingest path.

## Work Guidance

- Keep mode checks at the top of each handler.
- Keep temporary files out of committed paths and clean them up where practical.
- Route clinical AI work through backend AI job contracts instead.

## Verification

- `npm run type-check --workspace frontend`

## Child DOX Index
