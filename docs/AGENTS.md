# Design Documents DOX

Last updated: 2026-09-22

## Purpose and ownership

- Own written design specifications and implementation plans under `docs/`, including the architectural brainstorming artifacts in `superpowers/specs/` and subsequent plans in `superpowers/plans/` when created.
- Research surveys and exploratory alternatives remain in `roadmap/`; link to them rather than duplicating their source research.
- Runtime code, tests, dependencies and operational instructions remain owned by their existing subtrees.

## Contracts

- Distinguish approval of conversational design sections, approval of the consolidated written specification, approval of an implementation plan, implementation and observed validation.
- A specification describes intended behavior. It must not imply that code, an evaluation dataset, live-provider acceptance or clinical validation already exists.
- Preserve the approved intent, product-surface boundaries, data handling, failure behavior and acceptance criteria. Record the current review stage in each artifact.
- Keep source snapshots dated and link external claims to their primary sources. Revalidate version-dependent details before implementation.
- Keep credentials, patient information, generated evaluation artifacts and private runtime data out of design documents and Git.
- Read the root DOX and the relevant runtime child DOX before turning a design into code. Update the owning runtime guidance with implementation, not merely because a design proposes it.

## Current specifications

- `superpowers/specs/2026-09-22-jev-pubmed-evidence-review-design.md`: public/synthetic PubMed evidence evaluation using a separate runner, immutable inputs, Jev assessments, blind review and comparative results. The user approved the written specification on 2026-09-22.
- `superpowers/plans/2026-09-22-jev-pubmed-evidence-review.md`: implementation tasks and verification for that specification. The user approved native execution on 2026-09-22. Implementation is in progress on `codex/jev-evidence-implementation`; provider and human-quality acceptance remain separate.

## Verification

- Review specifications for inconsistent requirements, ambiguous outcomes, unbounded side effects and unresolved placeholders.
- Check local links and run `git diff --check` for documentation-only changes. Runtime tests are only required when executable behavior changes.

## Child DOX Index

- None.
