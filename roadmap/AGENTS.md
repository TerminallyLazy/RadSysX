# Roadmap DOX

Last updated: 2026-09-22

## Purpose

- Own durable planning artifacts for future RadSysX work that spans multiple product surfaces or is not ready to become runtime code yet.
- Keep future implementation intent explicit enough that work can resume after context compaction, handoff, or a machine change.
- Capture dated source snapshots, assumptions, open questions, GPU evaluation plans, and cross-surface todo ledgers.

## Ownership

- Owns roadmap files under `roadmap/`, including AI backend plans, model evaluation notes, future architecture sketches, and implementation runbooks.
- The AI backend plan for the OHIF sidebar lives at `roadmap/ai-backend/PLAN.md`; the realtime voice/chat research synthesis lives at `roadmap/ai-backend/REALTIME_VOICE_RESEARCH.md`; first GPU bring-up evidence lives at `roadmap/ai-backend/GPU_EVAL_LOG.md`; the opt-in BioMedParse integration demo runbook lives at `roadmap/ai-backend/BIOMEDPARSE_DEMO.md`.
- Runtime code remains owned by the nearest applicable subtree such as `backend/`, `viewer/`, `frontend/`, `desktop/`, or `packages/`.

- `ai-backend/LIVE_IMPLEMENTATION.md` owns the Gemini/OpenAI implementation contract, canonical map/ticket links, dated verification evidence, and the NVIDIA VoiceChat deployment assessment. The user deferred VoiceChat; it is not implemented or enabled. Distinguish downloadable model access from a running provider endpoint. Its current decisions supersede the June prototype assumptions.
- `ai-backend/JEV_RESEARCH.md` owns the dated TypeSafe/Jev opportunity survey, source limitations and repository findings. It links to the user-approved specification under `docs/superpowers/specs/` and the approved native implementation plan under `docs/superpowers/plans/`. `ai-backend/JEV_EVALUATION.md` records actual software/provider evidence and pending human/visual acceptance; research/design documents alone do not establish acceptance. `docs/AGENTS.md` owns the specification and plan.

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

- `ai-backend/NIM_IMPLEMENTATION.md` owns the approved NIM evaluation/research extension, explicit provider configuration and dated live acceptance. It distinguishes direct evaluation from native DeepAgents/LangGraph research and keeps NIM separate from live voice.

- `ai-backend/JEV_VISION_ROUTING.md` owns the dated assessment of Jev text judgments paired with vision models, contextual tool suggestions, model input compatibility and research validation. These are proposed follow-ons, not installed detectors or clinical capabilities.

- `ai-backend/JEV_SIDEBAR_IMPLEMENTATION.md` records the explicit sidebar review workflow, source/consent and private-storage contracts, dated app/live receipt evidence and remaining human-quality limitations. Keep it distinct from the standalone evaluator runbook and the proposed vision-routing assessment.
- `ai-backend/DESKTOP_AI_ACTIVATION.md` records the working-checkout/environment activation, startup hardening and real desktop-served sidebar acceptance. Distinguish configuration checks, synthetic-provider smokes and actual hosted-provider requests. MLX VoiceChat remains deferred.

- `ai-backend/CODEX_SUBSCRIPTION.md` owns the local subscription workflow, pinned App Server boundary, per-user keyring custody, public PubMed execution and actual acceptance evidence. Preserve the distinction between synthetic/native protocol checks and authenticated subscription inference.

- `ai-backend/CODEX_VIEWER_TOOL_MATRIX.md` records the actual pinned native toolbar inventory, semantic handlers, permission boundaries and per-control native acceptance. Pending in-scope handlers/fixtures block a parity claim; inventory is not activation evidence.

- `ai-backend/CODEX_STUDY_EXPLORATION.md` records the shipped study-sharing workflow, receipt semantics and actual acceptance boundaries. `CODEX_VIEWER_TOOL_MATRIX.md` keeps specialized native controls explicitly unverified where fixtures have not been exercised.
