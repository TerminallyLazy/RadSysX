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

  if (!customElements.get("radsysx-workspace-panel")) {
    customElements.define("radsysx-workspace-panel", RadSysXWorkspacePanel);
  }

  installAiPanelTabLabeler();

  window.__RADSYSX_OHIF_EXTENSION__ = {
    id: EXTENSION_ID,
    preRegistration(context) {
      // Typed live runtime consumes this bounded host bridge, not arbitrary commands from a model.
      window.__RADSYSX_OHIF_MANAGERS__ = context;
      window.dispatchEvent(new Event("radsysx-ohif-ready"));
    },
    onModeExit() {
      window.dispatchEvent(new Event("radsysx-ohif-exit"));
    },
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
