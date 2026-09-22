# NVIDIA NIM evaluation and PubMed research

Approved and implemented locally on 2026-09-22, on `codex/jev-evidence-implementation` descended from `codex/gemini-live-assistant`. NIM extends evaluation and bounded public research; Gemini/OpenAI live voice profiles remain unchanged.

## Execution and configuration

Install the declared `backend/requirements-ai.txt` in the repo Python 3.12 `.venv`. It now pins `langchain-nvidia-ai-endpoints==1.4.3`; desktop dependency checks already derive all direct pins from this manifest.

The evidence evaluator uses one direct hosted chat completion per claim/abstract, with the common rubric, strict label validation and unchanged 10-second attempt/60-second snapshot limits. It records exact request/model/configuration identities, token usage and failures in the existing private artifacts. It never feeds judgments into answers.

Research still uses **DeepAgents on LangGraph**. Native `ChatNVIDIA` supplies its model, while the existing graph owns tool dispatch, structured synthesis, StateBackend scratch space, source checks and call budgets. The backend supervisor retains two isolated children maximum, a 120-second deadline, cancellation/cleanup and bounded output. NIM model transport allows 60 seconds per call inside the fixed 115-second graph/120-second job deadline; Gemini keeps its existing 30-second call timeout. It passes only the selected provider key. The restricted NIM harness must use the adapter's case-sensitive `NVIDIA:` identity.

Set these in backend `.env.ai` or the process environment, then restart the backend for changed research settings:

```dotenv
RADSYSX_NVIDIA_API_KEY=<your NVIDIA key>
RADSYSX_RESEARCH_PROVIDER=nvidia_nim
RADSYSX_NIM_RESEARCH_MODEL=z-ai/glm-5.3-flash
```

The user selected `z-ai/glm-5.3-flash` (exact authenticated catalog ID). Its documented endpoint default is maximum reasoning, so these bounded research/evaluation paths explicitly request `reasoning_effort=low` and `chat_template_kwargs.clear_thinking=true`. NVIDIA documents text/image input and text output; current RadSysX NIM requests remain text-only.

Gemini remains the default when `RADSYSX_RESEARCH_PROVIDER` is omitted. NIM requires an exact model and NVIDIA key; no automatic model/provider fallback exists. Personal Gemini/OpenAI credentials remain separate. NIM has no voice profile or browser credential setting. At the user's request, the original checkout's private `.env.ai` selects NIM research and `z-ai/glm-5.3-flash`; existing credentials remain untouched. These settings take effect when this implementation branch is run and the backend is restarted. The isolated implementation worktree does not contain a credential-file copy; probes used explicit `--env-file` or loaded the original backend file into the selected worker.

NIM research offers PubMed abstracts and existing virtual scratch/todo tools. Gemini's Google-grounded web/source tools stay in the Gemini lane. Both prohibit shell, MCP and subagents, enforce 16 actual tool calls and 12 model calls, and normalize citations against retrieved sources. Clinical mode disables cloud research. The evidence CLI likewise rejects clinical/unknown network modes and accepts only designated public/synthetic snapshots.

## Operator commands

```bash
.venv/bin/python -m backend.evidence_review models --provider nvidia_nim
.venv/bin/python -m backend.evidence_review replay \
  --snapshot /absolute/private/snapshot.json \
  --evaluator nvidia_nim --model z-ai/glm-5.3-flash
.venv/bin/python -m backend.evidence_review resume --run /absolute/private/run-directory
```

Use `--env-file` when credentials live outside the working checkout. Keys are never CLI arguments. NIM discovery uses `https://integrate.api.nvidia.com/v1/models` and returns IDs, not inferred capabilities. Other catalog models may reject tool calling/JSON, exceed limits or require different access. No model sweep runs automatically. The existing study capture command remains Gemini-only to preserve its generation protocol.

Evaluation failures distinguish auth, overload, timeout, malformed/truncated response and model mismatch. Error bodies and reasoning text are discarded. Research failures expose only the existing fixed failure result. Provider model IDs may be mutable aliases; exact request IDs are not immutable-weight guarantees. Developer-account pricing and remaining credits are not inferred: unpriced or unreceipted usage stays unknown.

## Validation on 2026-09-22

- Independent scope review (`01686f9..9269cbc`): no Critical, Important or Minor findings; 55 focused offline tests passed in the review. Live receipts below remain separate.
- Desktop dependency inspector: NVIDIA adapter 1.4.3 present and no version mismatches.
- Native dependency compatibility: `pip check` clean; `pip-audit -r backend/requirements-ai.txt` reported no known vulnerabilities.
- Mocked HTTP tests verify fixed endpoints, byte/timeout limits, safe errors, strict response/model/usage validation, catalog mode/cancellation gates and resume without repeat inference.
- Actual compiled DeepAgents graphs with mocked NVIDIA calls verify PubMed dispatch, structured synthesis, citation filtering, absent Google/shell/subagent tools and shared tool budgets. Broker tests verify selected-key routing and personal Google-key isolation.
- Current regression tranche: 452 passed across evidence review, research, live broker, credential/security, OpenAI transport, connection-race and screen-awareness and clinical-platform tests. These are local checks, not hosted CI.
- Authenticated hosted catalog: 82 model IDs, including Lightning and GPT-OSS-20B.
- One synthetic evidence case with `openai/gpt-oss-20b`: completed in 2.532 seconds overall; exact resolved ID matched; 301 prompt, 113 completion, 414 total tokens. No probabilities or cost claim.
- Same case with `nvidia/nemotron-3.5-lightning-30b-a3b`: two 10-second timeouts, correctly recorded as failed with unknown usage/billing.
- First broader Lightning PubMed query failed after search progress. A targeted public PMID 21714641 query completed through the actual DeepAgents/LangGraph worker with one verified source, 2 model calls and 2 tool calls (8,899 input / 581 output / 9,480 total tokens). These probes do not establish comparative quality or consistent latency.

- Selected `z-ai/glm-5.3-flash`, explicit low reasoning: synthetic evaluator completed in 2.003 seconds overall, exact resolved ID, 245 prompt / 7 completion / 252 total tokens. Initial maximum-reasoning probe timed out twice at 10 seconds; those receipts are retained.

- Selected GLM actual isolated supervisor/worker: completed in 43.917 seconds, one retrieved PubMed source, 2 model calls and 2 tool calls, 7,844 input / 420 output / 8,264 total tokens. The earlier 30-second socket deadline failed during a later model call; the final 60-second NIM call allowance completed inside the unchanged job budget. No answer text or reasoning was stored for this connectivity probe.

Human Jev-study labels, held-out comparison, visual reports, physical audio and clinical acceptance remain separate. No hosted CI, deployment or default-provider change is implied.

## Primary sources checked

- [NVIDIA hosted chat API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b-infer): endpoint, generation limits and response statuses.
- [NVIDIA model directory](https://docs.api.nvidia.com/nim/reference/models-1) and authenticated `/v1/models`: available model families and current hosted IDs.
- [Native LangChain NVIDIA adapter source](https://github.com/langchain-ai/langchain-nvidia/blob/main/libs/ai-endpoints/langchain_nvidia_ai_endpoints/chat_models.py): model construction, async invocation and tool binding. Installed pinned source was also inspected.

- [GLM-5.3-Flash model card](https://build.nvidia.com/z-ai/glm-5-3-flash/modelcard): multimodal input, text output, reasoning options and clear-thinking setting. The website slug uses hyphens; the API model ID uses `z-ai/glm-5.3-flash`.

## Account model settings and compact sidebar

**Settings → Research models** offers a provider dropdown and an exact-model dropdown. NVIDIA uses all IDs from the authenticated hosted catalog, never a curated shortlist; the current read-only check returned 82 IDs including `z-ai/glm-5.3-flash`. Refresh bypasses the three-minute backend cache. Catalog failure keeps the saved choice and disables saving until discovery recovers. Unsupported tools or inference endpoints fail explicitly without fallback; listing every model does not make embedding/vision-only models compatible with text research.

Saving persists a signed-account preference over the environment default and ends that account's sessions/jobs before applying the change. Reconnect with fresh data confirmation. Other accounts, live voice profiles and explicit offline evaluator flags remain independent. NVIDIA credentials still come from backend configuration; Gemini/OpenAI key inputs are now under **Settings → API keys**.

The large sidebar slogan/microphone card is removed. A single header row and inline confirmation/connect leave conversation space available; active media controls remain explicit in a compact toolbar. Data attestation and provider disclosure are preserved.

Browser preview verification used the actual production bundle with simulated session/settings responses and a freshly fetched real catalog: all 82 model options visible, alternate-model save/reopen verified, and selected GLM restored. At a 384-pixel panel width the disconnected controls occupy about 153 pixels. This preview is separate from backend persistence tests and real Electron/OHIF acceptance.

Settings verification on 2026-09-22:

- 464 local backend regressions passed, including new signed-owner preference/persistence/catalog failure tests. 31 viewer runtime tests passed; frontend/viewer typechecks and production viewer build passed.
- Actual Electron/OHIF `node desktop/scripts/ui-import-smoke.mjs --local-start --ai-live --openai` passed with synthetic DICOM, guarded provider and fake microphone. It verified fresh attestation, exact OpenAI audio profile, 960-byte PCM frames, mute/end cessation, active-image sharing/receipt, completed viewer actions and draft/annotation undo/redo. No cloud inference or physical microphone was used.
- The 280-pixel-wide connected sidebar retained 503 pixels of conversation height within an 852-pixel panel; ended layout retained 453 pixels. Composer bounds passed in both states. Before connecting, media controls were hidden/disabled and no session was allocated.
