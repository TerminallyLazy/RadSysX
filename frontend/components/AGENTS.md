# Frontend Components DOX

## Purpose

- Own reusable React components, UI primitives, and research viewer components in the Next.js shell.

## Ownership

- Owns top-level components plus `core/`, `layouts/`, `modals/`, `providers/`, `toolbars/`, `ui/`, and `viewer/`.

## Local Contracts

- `core/CoreViewer.tsx`, `DicomViewer.tsx`, viewer toolbars, and upload/media controls are research/parity surfaces unless explicitly wired through clinical contracts.
- Clinical workflow UI belongs in login/worklist routes or the OHIF viewer extension, not in the legacy research viewer.
- Keep UI components free of hidden clinical authority such as inferred actor identity or local report persistence.

## Work Guidance

- Follow existing component style and Tailwind conventions.
- Use existing UI primitives before inventing new ones.
- Keep fixed-format viewer controls dimensionally stable across mobile and desktop.

## Verification

- `npm run type-check --workspace frontend`

## Child DOX Index
