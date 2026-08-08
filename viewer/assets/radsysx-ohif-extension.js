// @ts-check

/** @typedef {import("@radsysx/clinical-web/contracts").ImagingLaunchResolveResponse} ImagingLaunchResolveResponse */
/** @typedef {import("@radsysx/clinical-web/contracts").StudyWorkspace} StudyWorkspace */
/** @typedef {import("@radsysx/clinical-web/contracts").ReportRecord} ReportRecord */

(function radsysxOHIFExtension() {
  const React = window.React;
  if (!React) {
    throw new Error("The RadSysX OHIF extension requires React to be available globally.");
  }

  const EXTENSION_ID = "@radsysx/extension-clinical";
  const DEFAULT_DICOMWEB_NAMESPACE = "@ohif/extension-default.dataSourcesModule.dicomweb";
  const WORKSPACE_PANEL_ID = `${EXTENSION_ID}.panelModule.workspace`;
  const AI_CHAT_PANEL_ID = `${EXTENSION_ID}.panelModule.aiChat`;
  const AI_ATTACHMENT_OPTIONS = [
    {
      kind: "roi",
      label: "ROI",
      body: "Current region context",
    },
    {
      kind: "segmentation",
      label: "Segmentation",
      body: "Visible segment context",
    },
    {
      kind: "measurement",
      label: "Measurement",
      body: "Active measurement context",
    },
  ];

  class RadSysXWorkspacePanel extends HTMLElement {
    connectedCallback() {
      if (this.dataset.connected === "true") {
        return;
      }

      this.dataset.connected = "true";
      this.classList.add("radsysx-panel-root");
      this.state = {
        workspace: /** @type {StudyWorkspace | null} */ (null),
        message: /** @type {string | null} */ (null),
        error: /** @type {string | null} */ (null),
        loading: true,
        draftFindings: "",
        draftImpression: "",
      };
      this.render();
      window.__RADSYSX_CLEAN_VIEWER_URL__?.();
      void this.refreshWorkspace();
    }

    latestReport() {
      return this.state.workspace?.reports?.[0] ?? null;
    }

    hydrateDrafts() {
      const report = this.latestReport();
      if (!report) {
        return;
      }
      this.state.draftFindings = report.findingsSummary ?? "";
      this.state.draftImpression = report.impression ?? "";
    }

    resolvedLaunch() {
      return /** @type {ImagingLaunchResolveResponse | undefined} */ (window.__RADSYSX_LAUNCH__);
    }

    featureFlags() {
      return this.resolvedLaunch()?.viewerRuntime?.featureFlags ?? {};
    }

    async refreshWorkspace() {
      const resolved = this.resolvedLaunch();
      if (!resolved) {
        this.state.loading = false;
        this.state.error = "Viewer launch context is unavailable.";
        this.render();
        return;
      }

      try {
        this.state.loading = true;
        this.render();
        this.state.workspace = await requestJson(
          `/api/studies/${encodeURIComponent(resolved.context.studyInstanceUID)}/workspace`,
        );
        this.hydrateDrafts();
        this.state.error = null;
      } catch (error) {
        this.state.error = error instanceof Error ? error.message : "Unable to load workspace.";
      } finally {
        this.state.loading = false;
        this.render();
        const loader = document.getElementById("radsysx-loader");
        if (loader) {
          loader.remove();
        }
      }
    }

    async saveReport(status) {
      const resolved = this.resolvedLaunch();
      if (!resolved) {
        return;
      }

      this.state.message = null;
      this.state.error = null;
      const findings = /** @type {HTMLTextAreaElement | null} */ (
        this.querySelector("#radsysx-findings")
      );
      const impression = /** @type {HTMLTextAreaElement | null} */ (
        this.querySelector("#radsysx-impression")
      );
      this.state.draftFindings = findings?.value ?? "";
      this.state.draftImpression = impression?.value ?? "";

      try {
        const report = this.latestReport();
        await requestJson("/api/reports/draft", {
          method: "POST",
          body: JSON.stringify({
            reportId: report?.reportId,
            studyInstanceUID: resolved.context.studyInstanceUID,
            status,
            findingsSummary: this.state.draftFindings,
            impression: this.state.draftImpression,
          }),
        });
        this.state.message =
          status === "final"
            ? "Report finalized through the governed backend contract."
            : "Draft report saved.";
        await this.refreshWorkspace();
      } catch (error) {
        this.state.error = error instanceof Error ? error.message : "Unable to save the report.";
        this.render();
      }
    }

    async queueShadowTriage() {
      const resolved = this.resolvedLaunch();
      if (!resolved) {
        return;
      }

      this.state.message = null;
      this.state.error = null;
      try {
        await requestJson("/api/ai/jobs", {
          method: "POST",
          body: JSON.stringify({
            kind: "triage",
            workflowMode: "shadow",
            studyInstanceUID: resolved.context.studyInstanceUID,
            modelId: "triage-model",
            modelVersion: "1.0.0",
            inputHash: `study:${resolved.context.studyInstanceUID}:shadow`,
          }),
        });
        this.state.message = "Shadow triage queued.";
        await this.refreshWorkspace();
      } catch (error) {
        this.state.error = error instanceof Error ? error.message : "Unable to queue AI job.";
        this.render();
      }
    }

    async uploadDerived(objectType, storageClass, inputId) {
      const resolved = this.resolvedLaunch();
      if (!resolved) {
        return;
      }

      this.state.message = null;
      this.state.error = null;
      const input = /** @type {HTMLInputElement | null} */ (this.querySelector(`#${inputId}`));
      const file = input?.files?.[0];
      if (!file) {
        this.state.error = `Select a ${storageClass} DICOM file first.`;
        this.render();
        return;
      }

      const form = new FormData();
      form.set("studyInstanceUID", resolved.context.studyInstanceUID);
      form.set("objectType", objectType);
      form.set("storageClass", storageClass);
      form.set("metadata", JSON.stringify({ source: "radsysx-ohif-panel" }));
      form.append("files", file, file.name);

      try {
        const response = await fetch("/api/derived-results/stow", {
          method: "POST",
          body: form,
          credentials: "include",
        });
        if (!response.ok) {
          throw new Error((await response.text()) || "STOW request failed.");
        }
        this.state.message = `${storageClass} persisted through backend STOW.`;
        await this.refreshWorkspace();
      } catch (error) {
        this.state.error =
          error instanceof Error ? error.message : "Unable to persist derived DICOM.";
        this.render();
      }
    }

    bindActions() {
      this.querySelector("[data-action='refresh']")?.addEventListener("click", () => {
        this.state.message = null;
        void this.refreshWorkspace();
      });
      this.querySelector("[data-action='save-draft']")?.addEventListener("click", () => {
        void this.saveReport("draft");
      });
      this.querySelector("[data-action='finalize-report']")?.addEventListener("click", () => {
        void this.saveReport("final");
      });
      this.querySelector("[data-action='queue-ai']")?.addEventListener("click", () => {
        void this.queueShadowTriage();
      });
      this.querySelector("[data-action='upload-sr']")?.addEventListener("click", () => {
        void this.uploadDerived("sr", "SR", "radsysx-upload-sr");
      });
      this.querySelector("[data-action='upload-seg']")?.addEventListener("click", () => {
        void this.uploadDerived("seg", "SEG", "radsysx-upload-seg");
      });
    }

    render() {
      const resolved = this.resolvedLaunch();
      const report = this.latestReport();
      const flags = this.featureFlags();
      const workspace = this.state.workspace;
      const auditItems = workspace?.audit?.slice(0, 8) ?? [];

      this.innerHTML = `
        <div class="radsysx-panel-shell">
          <div class="radsysx-panel-header">
            <div>
              <div class="radsysx-panel-kicker">RadSysX Clinical Workspace</div>
              <div class="radsysx-panel-title">${escapeHtml(
                resolved?.context.accessionNumber ?? "Governed viewer session",
              )}</div>
              <div class="radsysx-panel-subtitle">
                ${escapeHtml(resolved?.viewerRuntime.viewerKind ?? "ohif")} runtime
              </div>
            </div>
            <button class="radsysx-ghost-button" data-action="refresh" type="button">
              Refresh
            </button>
          </div>

          ${
            this.state.loading
              ? '<div class="radsysx-status">Loading governed workspace state...</div>'
              : ""
          }
          ${
            this.state.message
              ? `<div class="radsysx-status radsysx-status-success">${escapeHtml(this.state.message)}</div>`
              : ""
          }
          ${
            this.state.error
              ? `<div class="radsysx-status radsysx-status-error">${escapeHtml(this.state.error)}</div>`
              : ""
          }

          ${
            flags.reportPanel !== false
              ? `
                <section class="radsysx-section">
                  <div class="radsysx-section-title">Report</div>
                  <label class="radsysx-field">
                    <span>Findings</span>
                    <textarea id="radsysx-findings" rows="5">${escapeHtml(this.state.draftFindings)}</textarea>
                  </label>
                  <label class="radsysx-field">
                    <span>Impression</span>
                    <textarea id="radsysx-impression" rows="4">${escapeHtml(this.state.draftImpression)}</textarea>
                  </label>
                  <div class="radsysx-row">
                    <button class="radsysx-primary-button" data-action="save-draft" type="button">Save draft</button>
                    <button class="radsysx-ghost-button" data-action="finalize-report" type="button">Finalize</button>
                  </div>
                  <div class="radsysx-caption">
                    Latest status: ${escapeHtml(report?.status ?? "No report yet")}
                  </div>
                </section>
              `
              : ""
          }

          ${
            flags.aiPanel !== false || flags.derivedPanel !== false
              ? `
                <section class="radsysx-section">
                  <div class="radsysx-section-title">Assistive Actions</div>
                  ${
                    flags.aiPanel !== false
                      ? `
                        <div class="radsysx-row radsysx-row-stack">
                          <button class="radsysx-ghost-button" data-action="queue-ai" type="button">
                            Queue shadow triage
                          </button>
                        </div>
                        <div class="radsysx-list">
                          ${renderItems(
                            workspace?.aiJobs?.map((item) => ({
                              title: `${item.kind} · ${item.workflowMode}`,
                              body: `${item.jobId} · ${item.status}`,
                            })),
                            "No governed AI jobs queued.",
                          )}
                        </div>
                      `
                      : ""
                  }
                  ${
                    flags.derivedPanel !== false
                      ? `
                        <div class="radsysx-upload-block">
                          <label class="radsysx-upload-label">
                            <span>Upload DICOM SR</span>
                            <input id="radsysx-upload-sr" type="file" accept=".dcm,application/dicom" />
                          </label>
                          <button class="radsysx-ghost-button" data-action="upload-sr" type="button">STOW SR</button>
                        </div>
                        <div class="radsysx-upload-block">
                          <label class="radsysx-upload-label">
                            <span>Upload DICOM SEG</span>
                            <input id="radsysx-upload-seg" type="file" accept=".dcm,application/dicom" />
                          </label>
                          <button class="radsysx-ghost-button" data-action="upload-seg" type="button">STOW SEG</button>
                        </div>
                        <div class="radsysx-list">
                          ${renderItems(
                            workspace?.derivedResults?.map((item) => ({
                              title: `${item.objectType} · ${item.storageClass}`,
                              body: item.payloadRef ?? item.id,
                            })),
                            "No derived DICOM objects persisted.",
                          )}
                        </div>
                      `
                      : ""
                  }
                </section>
              `
              : ""
          }

          ${
            flags.auditPanel !== false
              ? `
                <section class="radsysx-section">
                  <div class="radsysx-section-title">Audit</div>
                  <div class="radsysx-list">
                    ${renderItems(
                      auditItems.map((item) => ({
                        title: item.action,
                        body: `${item.actorUserId} · ${formatDate(item.occurredAt)}`,
                      })),
                      "No audit events recorded yet.",
                    )}
                  </div>
                </section>
              `
              : ""
          }
        </div>
      `;

      this.bindActions();
    }
  }

  class RadSysXAIChatPanel extends HTMLElement {
    connectedCallback() {
      if (this.dataset.connected === "true") {
        return;
      }

      this.dataset.connected = "true";
      this.classList.add("radsysx-panel-root", "radsysx-ai-chat-root");
      this.state = {
        messages: [
          {
            role: "assistant",
            text: "Voice-first RadSysX AI is warming up.",
            attachments: [],
          },
        ],
        draft: "",
        attachments: [],
        mentionOpen: false,
        listening: false,
        voiceStatus: "Ready",
        interimTranscript: "",
        backendStatus: "connecting",
        backendSessionId: null,
        backendMessage: null,
        capabilities: null,
        sending: false,
        lastInputSource: "typed",
      };
      this.recognition = null;
      this.backendInitPromise = null;
      this.render();
      void this.initializeBackend();
    }

    disconnectedCallback() {
      this.stopVoiceInput();
    }

    bindActions() {
      this.querySelector("form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.sendMessage();
      });
      this.querySelector("textarea")?.addEventListener("input", (event) => {
        this.handleDraftInput(event);
      });
      this.querySelector("textarea")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void this.sendMessage();
        }
      });
      this.querySelector("[data-action='toggle-mention']")?.addEventListener("click", () => {
        this.state.mentionOpen = !this.state.mentionOpen;
        this.render();
      });
      this.querySelector("[data-action='voice']")?.addEventListener("click", () => {
        this.toggleVoiceInput();
      });
      this.querySelectorAll("[data-attachment-kind]").forEach((button) => {
        button.addEventListener("click", () => {
          this.addAttachment(button.getAttribute("data-attachment-kind") ?? "");
        });
      });
      this.querySelectorAll("[data-remove-attachment]").forEach((button) => {
        button.addEventListener("click", () => {
          this.removeAttachment(button.getAttribute("data-remove-attachment") ?? "");
        });
      });
    }

    async initializeBackend() {
      if (this.backendInitPromise) {
        return this.backendInitPromise;
      }

      this.backendInitPromise = (async () => {
        try {
          const capabilities = await requestJson("/api/ai/sidebar/capabilities");
          const session = await requestJson("/api/ai/sidebar/sessions", {
            method: "POST",
            body: JSON.stringify({
              viewerContext: this.buildViewerContext(),
            }),
          });
          this.state.capabilities = capabilities;
          this.state.backendSessionId = session.sessionId;
          this.state.backendStatus = "ready";
          this.state.backendMessage = session.message;
          this.state.messages = [
            {
              role: "assistant",
              text: session.message,
              attachments: [],
            },
          ];
        } catch (error) {
          this.state.backendStatus = "local";
          this.state.backendMessage = null;
          this.state.messages = [
            {
              role: "assistant",
              text: "Local voice draft mode is available. Backend AI session is not connected.",
              attachments: [],
            },
          ];
          console.warn("RadSysX AI backend session is unavailable.", error);
        }
        this.render();
        this.scrollThreadToBottom();
      })();

      return this.backendInitPromise;
    }

    handleDraftInput(event) {
      const textarea = /** @type {HTMLTextAreaElement} */ (event.target);
      this.state.draft = textarea.value;
      this.state.lastInputSource = "typed";
      const cursor = textarea.selectionStart ?? textarea.value.length;
      const beforeCursor = textarea.value.slice(0, cursor);
      const shouldOpenMention = /(^|\s)@[\w-]*$/.test(beforeCursor);
      if (shouldOpenMention !== this.state.mentionOpen) {
        this.state.mentionOpen = shouldOpenMention;
        this.render();
      }
    }

    addAttachment(kind) {
      const option = AI_ATTACHMENT_OPTIONS.find((item) => item.kind === kind);
      if (!option) {
        return;
      }

      const exists = this.state.attachments.some((item) => item.kind === option.kind);
      if (!exists) {
        this.state.attachments.push({
          id: `${option.kind}-${Date.now()}`,
          kind: option.kind,
          label: option.label,
        });
      }

      this.state.draft = this.state.draft.replace(/(^|\s)@[\w-]*$/, "$1").trimStart();
      this.state.mentionOpen = false;
      this.render();
      this.querySelector("textarea")?.focus();
    }

    removeAttachment(id) {
      this.state.attachments = this.state.attachments.filter((item) => item.id !== id);
      this.render();
    }

    async sendMessage() {
      if (this.state.sending) {
        return;
      }

      const textarea = /** @type {HTMLTextAreaElement | null} */ (this.querySelector("textarea"));
      const draft = (textarea?.value ?? this.state.draft).trim();
      if (!draft && this.state.attachments.length === 0) {
        return;
      }

      const attachments = this.state.attachments.map((item) => ({ ...item }));
      const inputSource = this.state.lastInputSource === "voice" ? "voice" : "typed";
      this.state.messages.push({
        role: "user",
        text: draft || "Attached viewer context.",
        attachments,
      });
      this.state.draft = "";
      this.state.attachments = [];
      this.state.mentionOpen = false;
      this.state.interimTranscript = "";
      this.state.voiceStatus = this.state.listening ? "Listening" : "Ready";
      this.state.lastInputSource = "typed";
      this.state.sending = true;
      this.render();
      this.scrollThreadToBottom();

      if (this.state.backendStatus === "ready" && this.state.backendSessionId) {
        try {
          const response = await requestJson(
            `/api/ai/sidebar/sessions/${encodeURIComponent(this.state.backendSessionId)}/messages`,
            {
              method: "POST",
              body: JSON.stringify({
                text: draft,
                inputSource,
                attachments: attachments.map((item) => ({
                  id: item.id,
                  kind: item.kind,
                  label: item.label,
                  metadata: {},
                })),
                viewerContext: this.buildViewerContext(),
              }),
            },
          );
          this.state.messages.push({
            role: "assistant",
            text: response.assistantMessage?.text ?? "Backend turn completed.",
            attachments: [],
          });
        } catch (error) {
          this.state.messages.push({
            role: "assistant",
            text: "Backend turn failed. Local draft was captured only.",
            attachments: [],
          });
          console.warn("RadSysX AI backend turn failed.", error);
        }
      } else {
        this.state.messages.push({
          role: "assistant",
          text: "Local draft captured. Backend AI orchestration is not connected yet.",
          attachments: [],
        });
      }

      this.state.sending = false;
      this.render();
      this.scrollThreadToBottom();
    }

    toggleVoiceInput() {
      if (this.state.listening) {
        this.stopVoiceInput();
        this.state.listening = false;
        this.state.voiceStatus = "Ready";
        this.state.interimTranscript = "";
        this.render();
        return;
      }

      const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      if (!Recognition) {
        this.state.voiceStatus = "Unavailable";
        this.render();
        return;
      }

      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";
      recognition.onresult = (event) => {
        let finalTranscript = "";
        let interimTranscript = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript ?? "";
          if (result?.isFinal) {
            finalTranscript = [finalTranscript, transcript].filter(Boolean).join(" ").trim();
          } else {
            interimTranscript = [interimTranscript, transcript].filter(Boolean).join(" ").trim();
          }
        }

        if (finalTranscript) {
          this.appendDraftText(finalTranscript, "voice");
        }
        this.state.interimTranscript = interimTranscript;
        this.updateVoicePreview();
      };
      recognition.onerror = (event) => {
        this.state.listening = false;
        this.state.voiceStatus = event.error ? `Stopped: ${event.error}` : "Unavailable";
        this.state.interimTranscript = "";
        this.render();
      };
      recognition.onend = () => {
        this.state.listening = false;
        if (this.state.voiceStatus === "Listening") {
          this.state.voiceStatus = "Ready";
        }
        this.state.interimTranscript = "";
        this.render();
      };

      this.recognition = recognition;
      this.state.listening = true;
      this.state.voiceStatus = "Listening";
      this.render();
      try {
        recognition.start();
      } catch (error) {
        this.state.listening = false;
        this.state.voiceStatus =
          error instanceof Error ? error.message : "Could not start";
        this.state.interimTranscript = "";
        this.render();
      }
    }

    appendDraftText(text, source) {
      if (!text.trim()) {
        return;
      }
      this.state.draft = [this.state.draft, text.trim()].filter(Boolean).join(" ").trim();
      this.state.lastInputSource = source;
      const textarea = /** @type {HTMLTextAreaElement | null} */ (this.querySelector("textarea"));
      if (textarea) {
        textarea.value = this.state.draft;
      }
    }

    updateVoicePreview() {
      const preview = this.querySelector("[data-role='voice-transcript']");
      if (preview) {
        preview.textContent = this.state.interimTranscript || this.state.draft || "Ready";
      }
    }

    stopVoiceInput() {
      if (!this.recognition) {
        return;
      }

      try {
        this.recognition.stop();
      } catch (error) {
        console.warn("Unable to stop RadSysX voice input.", error);
      }
      this.recognition = null;
    }

    buildViewerContext() {
      const launch = getLaunchContext();
      return {
        studyInstanceUID: launch?.studyInstanceUID ?? null,
        seriesInstanceUID: launch?.seriesInstanceUIDs?.[0] ?? null,
        sopInstanceUID: null,
        route: `${window.location.pathname}${window.location.search}`,
        privacyClass: launch?.studyInstanceUID ? "phi-bearing" : "local-only",
      };
    }

    scrollThreadToBottom() {
      const thread = this.querySelector(".radsysx-ai-thread");
      if (thread) {
        thread.scrollTop = thread.scrollHeight;
      }
    }

    render() {
      const backendLabel =
        this.state.backendStatus === "ready"
          ? "Backend"
          : this.state.backendStatus === "connecting"
            ? "Connecting"
            : "Local";
      const voicePreview = this.state.interimTranscript || this.state.draft || "Ready";
      this.innerHTML = `
        <div class="radsysx-ai-shell">
          <div class="radsysx-panel-header radsysx-ai-header">
            <div>
              <div class="radsysx-panel-kicker">RadSysX AI</div>
              <div class="radsysx-panel-title">Voice assistant</div>
            </div>
            <div class="radsysx-ai-state" data-state="${escapeHtml(this.state.backendStatus)}">${backendLabel}</div>
          </div>

          <section class="radsysx-ai-voice-card" data-listening="${this.state.listening ? "true" : "false"}">
            <button
              class="radsysx-ai-voice-button"
              data-action="voice"
              data-active="${this.state.listening ? "true" : "false"}"
              type="button"
              title="Voice input"
              aria-label="Voice input"
            >
              ${renderMicIcon()}
            </button>
            <div class="radsysx-ai-voice-copy">
              <div class="radsysx-ai-voice-status">${escapeHtml(this.state.voiceStatus ?? "Ready")}</div>
              <div class="radsysx-ai-transcript-preview" data-role="voice-transcript">${escapeHtml(voicePreview)}</div>
            </div>
          </section>

          <div class="radsysx-ai-thread" role="log" aria-label="RadSysX AI chat">
            ${this.state.messages.map((message) => renderAiMessage(message)).join("")}
          </div>

          <form class="radsysx-ai-composer">
            ${
              this.state.attachments.length > 0
                ? `<div class="radsysx-ai-attachment-row">
                    ${this.state.attachments.map((item) => renderComposerAttachment(item)).join("")}
                  </div>`
                : ""
            }

            <div class="radsysx-ai-mention-menu" data-open="${this.state.mentionOpen ? "true" : "false"}">
              ${AI_ATTACHMENT_OPTIONS.map(renderAttachmentOption).join("")}
            </div>

            <textarea
              rows="3"
              aria-label="RadSysX AI message"
              placeholder="Type or edit transcript"
            >${escapeHtml(this.state.draft)}</textarea>

            <div class="radsysx-ai-composer-footer">
              <div class="radsysx-ai-composer-actions">
                <button
                  class="radsysx-ai-icon-button"
                  data-action="toggle-mention"
                  type="button"
                  title="Attach ROI or segmentation"
                  aria-label="Attach ROI or segmentation"
                >@</button>
              </div>
              <button
                class="radsysx-ai-send-button"
                type="submit"
                title="Send"
                aria-label="Send message"
                ${this.state.sending ? "disabled" : ""}
              >${renderSendIcon()}</button>
            </div>
          </form>
        </div>
      `;

      this.bindActions();
    }
  }

  if (!customElements.get("radsysx-workspace-panel")) {
    customElements.define("radsysx-workspace-panel", RadSysXWorkspacePanel);
  }

  if (!customElements.get("radsysx-ai-chat-panel")) {
    customElements.define("radsysx-ai-chat-panel", RadSysXAIChatPanel);
  }
  installAiPanelTabLabeler();

  window.__RADSYSX_OHIF_EXTENSION__ = {
    id: EXTENSION_ID,
    getDataSourcesModule() {
      return [
        {
          name: "dicomweb",
          type: "webApi",
          createDataSource(configuration, servicesManager, extensionManager) {
            const defaultModule = extensionManager?.getModuleEntry?.(DEFAULT_DICOMWEB_NAMESPACE);

            if (!defaultModule?.createDataSource) {
              throw new Error("The default OHIF dicomweb data source is unavailable.");
            }

            const runtimeConfiguration = {
              ...(configuration ?? {}),
            };
            const dataSource = defaultModule.createDataSource(
              runtimeConfiguration,
              servicesManager,
              extensionManager,
            );
            const originalInitialize = dataSource.initialize?.bind(dataSource);
            const originalGetStudyInstanceUIDs = dataSource.getStudyInstanceUIDs?.bind(dataSource);
            const originalRetrieveSeriesMetadata =
              dataSource.retrieve?.series?.metadata?.bind(dataSource.retrieve.series);

            if (originalInitialize) {
              dataSource.initialize = async function initialize(initArgs) {
                await window.__RADSYSX_BOOTSTRAP_PROMISE__;
                applyViewerRuntimeToDicomwebConfiguration(runtimeConfiguration);
                return originalInitialize(initArgs);
              };
            }

            if (originalGetStudyInstanceUIDs) {
              dataSource.getStudyInstanceUIDs = function getStudyInstanceUIDs(initArgs) {
                const studyInstanceUIDs = originalGetStudyInstanceUIDs(initArgs);
                const launchStudyUid = getLaunchContext()?.studyInstanceUID;
                return studyInstanceUIDs?.filter(Boolean).length
                  ? studyInstanceUIDs
                  : launchStudyUid
                    ? [launchStudyUid]
                    : studyInstanceUIDs;
              };
            }

            if (dataSource.retrieve?.series && originalRetrieveSeriesMetadata) {
              dataSource.retrieve.series.metadata = function metadata(args) {
                return originalRetrieveSeriesMetadata(injectLaunchSeriesFilters(args));
              };
            }

            return dataSource;
          },
        },
      ];
    },
    getPanelModule() {
      return [
        {
          name: "workspace",
          iconName: "tab-studies",
          iconLabel: "Workspace",
          label: "RadSysX Workspace",
          component: () => React.createElement("radsysx-workspace-panel"),
        },
        {
          name: "aiChat",
          iconName: "AI",
          iconLabel: "AI",
          label: "RadSysX AI",
          component: () => React.createElement("radsysx-ai-chat-panel"),
        },
      ];
    },
  };

  function renderAiMessage(message) {
    const role = message.role === "user" ? "You" : "RadSysX AI";
    return `
      <article class="radsysx-ai-message" data-role="${escapeHtml(message.role)}">
        <div class="radsysx-ai-message-role">${escapeHtml(role)}</div>
        <div class="radsysx-ai-message-body">${escapeHtml(message.text)}</div>
        ${renderAttachmentChips(message.attachments)}
      </article>
    `;
  }

  function renderAttachmentChips(attachments) {
    if (!attachments || attachments.length === 0) {
      return "";
    }

    return `
      <div class="radsysx-ai-message-attachments">
        ${attachments
          .map(
            (item) => `
              <span class="radsysx-ai-chip">
                @${escapeHtml(item.label)}
              </span>
            `,
          )
          .join("")}
      </div>
    `;
  }

  function renderComposerAttachment(item) {
    return `
      <span class="radsysx-ai-chip radsysx-ai-chip-removable">
        @${escapeHtml(item.label)}
        <button
          data-remove-attachment="${escapeHtml(item.id)}"
          type="button"
          title="Remove"
          aria-label="Remove ${escapeHtml(item.label)} attachment"
        >${renderCloseIcon()}</button>
      </span>
    `;
  }

  function renderAttachmentOption(option) {
    return `
      <button
        class="radsysx-ai-mention-option"
        data-attachment-kind="${escapeHtml(option.kind)}"
        type="button"
      >
        <span>@${escapeHtml(option.label)}</span>
        <small>${escapeHtml(option.body)}</small>
      </button>
    `;
  }

  function renderMicIcon() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
        <path d="M19 11a7 7 0 0 1-14 0" />
        <path d="M12 18v3" />
        <path d="M8 21h8" />
      </svg>
    `;
  }

  function renderSendIcon() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m5 12 14-7-5 14-2-5-7-2Z" />
        <path d="m12 14 7-9" />
      </svg>
    `;
  }

  function renderCloseIcon() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    `;
  }

  function installAiPanelTabLabeler() {
    const apply = () => {
      document.querySelectorAll("button").forEach((button) => {
        if (button.textContent?.trim() !== "Missing icon") {
          return;
        }
        button.classList.add("radsysx-ai-panel-tab");
        button.setAttribute("aria-label", "RadSysX AI");
        button.setAttribute("title", "RadSysX AI");
      });
    };

    const observe = () => {
      if (!document.body) {
        window.setTimeout(observe, 50);
        return;
      }
      apply();
      const observer = new MutationObserver(apply);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    };

    observe();
  }

  async function requestJson(path, init) {
    const response = await fetch(path, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      ...init,
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(payload || `Request failed: ${response.status}`);
    }

    return response.json();
  }

  function renderItems(items, empty) {
    if (!items || items.length === 0) {
      return `<div class="radsysx-empty">${escapeHtml(empty)}</div>`;
    }
    return items
      .map(
        (item) => `
          <div class="radsysx-item">
            <div class="radsysx-item-title">${escapeHtml(item.title)}</div>
            <div class="radsysx-item-body">${escapeHtml(item.body)}</div>
          </div>
        `,
      )
      .join("");
  }

  function formatDate(value) {
    if (!value) {
      return "";
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return parsed.toLocaleString();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function injectLaunchSeriesFilters(args) {
    const launchContext = getLaunchContext();
    const seriesInstanceUIDs = launchContext?.seriesInstanceUIDs ?? [];
    if (seriesInstanceUIDs.length === 0) {
      return args;
    }

    const filters = {
      ...(args?.filters ?? {}),
    };
    const hasSeriesFilter =
      filters.SeriesInstanceUID ||
      filters.SeriesInstanceUIDs ||
      filters.seriesInstanceUID ||
      filters.seriesInstanceUIDs;

    if (hasSeriesFilter) {
      return args;
    }

    return {
      ...(args ?? {}),
      filters: {
        ...filters,
        seriesInstanceUID: seriesInstanceUIDs,
      },
    };
  }

  function applyViewerRuntimeToDicomwebConfiguration(configuration) {
    const viewerRuntime = getViewerRuntime();
    if (!viewerRuntime || !configuration) {
      return configuration;
    }

    configuration.qidoRoot = normalizeSameOriginUrl(viewerRuntime.qidoRoot) || configuration.qidoRoot;
    configuration.wadoRoot = normalizeSameOriginUrl(viewerRuntime.wadoRoot) || configuration.wadoRoot;
    configuration.wadoUriRoot =
      normalizeSameOriginUrl(viewerRuntime.wadoUriRoot) ||
      normalizeSameOriginUrl(viewerRuntime.wadoRoot) ||
      configuration.wadoUriRoot ||
      configuration.wadoRoot;
    if (viewerRuntime.featureFlags?.directStow && viewerRuntime.stowRoot) {
      configuration.stowRoot = normalizeSameOriginUrl(viewerRuntime.stowRoot) || configuration.stowRoot;
    } else {
      delete configuration.stowRoot;
    }
    return configuration;
  }

  function getViewerRuntime() {
    return window.__RADSYSX_VIEWER_RUNTIME__ ?? window.__RADSYSX_LAUNCH__?.viewerRuntime ?? null;
  }

  function getLaunchContext() {
    return window.__RADSYSX_LAUNCH__?.context ?? null;
  }

  function normalizeSameOriginUrl(value) {
    const normalize = window.__RADSYSX_NORMALIZE_SAME_ORIGIN_URL__;
    return typeof normalize === "function" ? normalize(value) : value;
  }
})();
