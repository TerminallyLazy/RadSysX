# Roadmap DOX

Last updated: 2026-06-13

## Purpose

- Own durable planning artifacts for future RadSysX work that spans multiple product surfaces or is not ready to become runtime code yet.
- Keep future implementation intent explicit enough that work can resume after context compaction, handoff, or a machine change.
- Capture dated source snapshots, assumptions, open questions, GPU evaluation plans, and cross-surface todo ledgers.

## Ownership

- Owns roadmap files under `roadmap/`, including AI backend plans, model evaluation notes, future architecture sketches, and implementation runbooks.
- The AI backend plan for the OHIF sidebar lives at `roadmap/ai-backend/PLAN.md`; the realtime voice/chat research synthesis lives at `roadmap/ai-backend/REALTIME_VOICE_RESEARCH.md`; first GPU bring-up evidence lives at `roadmap/ai-backend/GPU_EVAL_LOG.md`; the opt-in BioMedParse integration demo runbook lives at `roadmap/ai-backend/BIOMEDPARSE_DEMO.md`.
- Runtime code remains owned by the nearest applicable subtree such as `backend/`, `viewer/`, `frontend/`, `desktop/`, or `packages/`.

## Local Contracts

- Roadmap documents are planning artifacts, not runtime behavior. Do not imply a feature is implemented merely because it is described here.
- Treat model names, licenses, URLs, performance claims, and API capabilities as dated source snapshots. Revalidate them before implementation, packaging, clinical use, or distribution.
- Keep research, pilot, and clinical mode boundaries explicit in every AI plan.
- Do not plan browser-direct PHI transfer to external AI services for `pilot` or `clinical`; route governed workflows through backend-mediated contracts.
- Do not commit model weights, gated model files, PHI, API tokens, patient identifiers, or generated clinical artifacts here.
- When roadmap work graduates into implementation, re-read the nearest owning `AGENTS.md` files for every code path touched and update durable docs in the same tranche.

## Work Guidance

- Prefer concrete checklists, runbooks, contract sketches, and verification gates over vague future prose.
- Include enough state for the next agent or future self to resume without relying on hidden conversation memory.
- Mark assumptions and unresolved decisions plainly.
- If a plan references external model repositories or API products, include links and the date they were checked.
- Favor local, open, auditable paths first, but keep API-backed realtime options as replaceable adapters when they improve accessibility or latency.

## Verification

- For roadmap-only changes, run `git diff --check` and inspect the rendered markdown logically.
- Runtime tests are not required for roadmap-only changes unless the plan edit also modifies code, dependencies, commands, or operational docs.

## Child DOX Index

- None yet.
