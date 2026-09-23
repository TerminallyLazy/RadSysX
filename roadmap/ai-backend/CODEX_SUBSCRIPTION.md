# ChatGPT / Codex subscription in the desktop sidebar

Implemented 2026-09-22. This is a local, synthetic/deidentified pilot integration. It does not enable clinical-mode cloud AI or supply OpenAI Realtime entitlement.

## User workflow

1. Run `npm run desktop`, open a study and choose AI → Settings.
2. Choose **Sign in with ChatGPT**, then **Continue sign-in in browser**. Complete OpenAI authentication yourself. Settings polls for Codex's confirmed account status; starting a login is not authentication proof.
3. Select **ChatGPT / Codex subscription** under Text & research models, choose an exact model from the authenticated Codex catalog, then save. Sign-in alone preserves the existing Gemini/NVIDIA selection.
4. Confirm synthetic/deidentified data. **Send** discusses the question and neutral case/series metadata; **Research** uses public PubMed abstracts. Both work without a voice connection. Research results retain citations, progress and requested-model receipts and remain eligible for the separate Jev review workflow.
5. **Sign out** ends this RadSysX account's jobs and clears its Codex login. It does not log out other Codex clients. **Cancel sign-in** stops a pending browser login. Refresh is a status read, never an inference request.

The subscription uses the account's Codex allowance and workspace restrictions. API-key providers retain their separate billing. Models are never silently substituted. No image pixels are supplied in this lane.

## Runtime and authentication

- The workspace pins `@openai/codex` **0.154.0** in the root npm lockfile. Bootstrap checks its installation; the backend invokes the workspace package with Node, never an arbitrary global binary.
- Desktop supplies `RADSYSX_CODEX_ENABLED=true` by default. Standalone backends default off; explicitly enable only for a trusted local installation. Linux/macOS require an available OS keyring. Unsupported private POSIX storage or unavailable keyring fails closed; there is no plaintext or API-key fallback.
- `ai_codex.py` owns one private stdio App Server per authenticated RadSysX actor, capped at eight processes. `.ai-codex/<sha256(actor)>/` beside the actual SQLite database isolates config/auth identity, with 0700 private directories and a 077 child umask. Its empty workspace is outside the project working directory. The isolated `CODEX_HOME` is passed only to that child. The existing user's Codex directory and tokens are never read/copied.
- `cli_auth_credentials_store=keyring` and `forced_login_method=chatgpt` delegate login, refresh and secure credential custody to Codex. Codex namespaces keyring records by canonical home path. Browser DTOs contain only account email/plan/status and a transient allowlisted HTTPS login URL; no bearer or refresh tokens.
- Backend-only GET `/api/ai/sidebar/codex/account`, POST `/codex/login`, POST `/codex/logout` use signed unexpired `ai.run` identity, enabled pilot/research mode, strict bounded empty write bodies, explicit allowed write Origin, fixed private errors and no-store responses. There is no public RPC proxy or caller-supplied actor, path, model endpoint or credential.
- Login expires after five minutes or the clinical session's expiry. Clinical logout closes the private process and pending login; a separately saved subscription login remains in its OS keyring for that RadSysX account. Explicit subscription sign-out removes it. Backend shutdown closes all children. Neither restart nor reconnect replays a turn.

## Execution boundary

Each job starts an ephemeral Codex thread using an exact selected model, `allowProviderModelFallback=false`, read-only sandbox, `approvalPolicy=never`, and **`environments: []`** on both thread and turn. The pinned Codex tool registry omits shell, patch and local-image handlers when there is no execution environment. Shell, images, browser/computer use, plugins/apps, memory, hooks, subagents and skill discovery are also disabled. The internal Codex tool host remains enabled because it forwards dynamic PubMed calls; Code Mode itself stays disabled. Project instruction loading is disabled and returned instruction sources, model/provider and sandbox are verified before the question is sent.

Text chat has no dynamic tools. Research exposes only `search_pubmed`, implemented by the existing backend retrieval/ledger adapter, with an eight-call budget, bounded queries/results and fixed NCBI endpoints. Other server requests are refused. Public abstracts are treated as untrusted evidence. Only final assistant text and ledger-backed sources become results; private reasoning and raw provider errors are discarded.

Owned text jobs retain existing idempotency, session/context binding, actor expiry, account mutation cancellation, two-job capacity, history and 120-second deadline. Codex turns have an additional 110-second execution wait. Cancellation interrupts and terminates the child if completion is unconfirmed, including a lost thread-start or turn-start acknowledgement; no retry can replay that turn. A later request starts a fresh process using Codex-managed keyring authentication.

Gemini/NVIDIA research retains its native DeepAgents/LangGraph graph. The subscription lane uses Codex's official harness with the same public PubMed retrieval boundary; it is not presented as LangGraph execution. Jev remains an explicit, separately confirmed TypeSafe operation.

## Verification

- Synthetic backend tests cover sign-in/ownership/model selection, text/research receipts, tool allowlisting/budgets, private errors, Origin/mode gates, cancellation before acknowledgement, model drift, account isolation and final-text filtering.
- Viewer tests cover explicit official login links, polling state, account confirmation, sign-out, malicious URLs and stale responses. Shared TypeScript contracts compile against the backend DTO shape.
- Native pinned App Server started under a disposable private home and reported signed out. An ephemeral read-only thread returned the exact requested model, OpenAI provider, empty instruction sources and network-disabled sandbox; no model turn or account inference was requested.
- The normal desktop launcher served the updated Settings panel at the actual app origin with **Sign in with ChatGPT** enabled and the user's existing NVIDIA model preserved. Only the generated checkerboard DICOM was loaded for visual acceptance.
- The user completed official ChatGPT Pro sign-in and selected `gpt-6-astra`. After a normal desktop restart, a separate synthetic session through the actual app origin retained that sign-in and model, returned a text answer in four seconds, and completed public PubMed research in sixteen seconds with three tool calls and three ledger-backed sources. Native sidebar history visibly showed both completed subscription receipts, source links and the available **Review evidence with Jev** action. No Jev request or image transmission was needed for this check. These are software/provider checks, not clinical or answer-quality validation.
- Local validation passed 226 backend regressions, 47 viewer protocol tests, 20 desktop protocol tests, root TypeScript checks, frontend/viewer builds and desktop doctor. Hosted CI is verified separately on the pull request.

## Official sources checked

- [Codex authentication](https://learn.chatgpt.com/docs/auth?surface=app)
- [App Server protocol](https://learn.chatgpt.com/docs/app-server): account/read, account/login/start, account/logout, model/list, ephemeral thread/start, turn/start, turn/interrupt and experimental dynamic tools.
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Pinned tool registration](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/spec_plan.rs) and [keyring identity](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/login/src/auth/storage.rs).

The integration opts into the pinned experimental environment/dynamic-tool fields. Changing the Codex version requires regenerating its protocol schemas and revalidating tool isolation and cancellation; do not float the dependency.
