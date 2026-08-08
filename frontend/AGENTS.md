# Frontend DOX

## Purpose

- Own the Next.js frontend shell for RadSysX, including the clinical worklist/login surface and research UI.

## Ownership

- Owns Next.js app routes, UI components, frontend libraries, styles, Tailwind/PostCSS/Next config, `schema.prisma`, and frontend package scripts.
- Child docs own route-level contracts, component boundaries, and frontend library rules.

## Local Contracts

- The clinical shell is `frontend/app/login/page.tsx` and `frontend/app/worklist/page.tsx`.
- `frontend/app/page.tsx` is a surface selector, not the clinical viewer runtime.
- There is no supported Next.js `/viewer` fallback. The public clinical viewer route is served by the dedicated `viewer/` app through nginx.
- Clinical API usage should go through `@/lib/clinical/client`, which re-exports `@radsysx/clinical-web/client`.
- `frontend/lib/api.ts` remains a legacy prototype convenience surface, not the authoritative clinical client.
- Research-only upload/analyze flows must remain gated outside `pilot` and `clinical`.
- The root app layout should stay light for clinical/desktop routes; do not wrap the clinical shell in unused research-era providers or dependencies that can break Electron/Next hydration.

## Work Guidance

- Use existing TypeScript strict-mode patterns.
- Keep clinical pages study-centric and backend-authoritative.
- Keep research viewer components separate from clinical launch/worklist flow.
- Do not send DICOM bytes directly from the browser to third-party AI services in `pilot` or `clinical`.

## Verification

- `npm run type-check --workspace frontend`
- `npm run build --workspace frontend`

## Child DOX Index

- `frontend/app/AGENTS.md`: Next.js route contracts.
- `frontend/components/AGENTS.md`: reusable UI and research viewer components.
- `frontend/lib/AGENTS.md`: frontend clients, env helpers, services, hooks, and utilities.
