// @ts-check

/** @typedef {import("@radsysx/clinical-web/contracts").ImagingLaunchResolveResponse} ImagingLaunchResolveResponse */
/** @typedef {import("@radsysx/clinical-web/contracts").ImagingLaunchResponse} ImagingLaunchResponse */
/** @typedef {import("@radsysx/clinical-web/contracts").SessionResponse} SessionResponse */

(async function radsysxBootstrap() {
  const LAUNCH_STORAGE_KEY = "radsysx.clinical.launchToken";
  const LOCAL_START_INSPECT_KEY = "radsysx.localStart.inspectStudyUid";
  const REQUEST_TIMEOUT_MS = 10000;
  const DROP_RELATIVE_PATH_KEY = "radsysxRelativePath";
  enforceRadSysXTitle();
  const params = new URLSearchParams(window.location.search);
  const localStartRequested = params.get("local") === "1";
  const initialViewerBasePath = resolveViewerBasePath(window.location.pathname) ?? "/";
  const startsInStandaloneFhirViewer = isStandaloneFhirRoute(
    viewerRelativePath(window.location.pathname, initialViewerBasePath),
  );
  const launchFromUrl = startsInStandaloneFhirViewer ? null : params.get("launch");
  const startsInStandaloneLocalViewer =
    !launchFromUrl && !window.__RADSYSX_LAUNCH__ && shouldUseStandaloneLocalViewer();
  let loader =
    startsInStandaloneLocalViewer || startsInStandaloneFhirViewer ? null : await ensureLoader();

  window.__RADSYSX_VIEWER_BASE_PATH__ = initialViewerBasePath;
  window.__RADSYSX_NORMALIZE_SAME_ORIGIN_URL__ = normalizeSameOriginUrl;

  window.__RADSYSX_BOOTSTRAP_PROMISE__ = bootstrap();

  try {
    await window.__RADSYSX_BOOTSTRAP_PROMISE__;
  } catch (error) {
    clearStoredLaunchToken();
    if (!loader) {
      loader = await ensureLoader();
    }
    fail(error instanceof Error ? error.message : "Unable to bootstrap the viewer.");
  }

  async function bootstrap() {
    if (startsInStandaloneFhirViewer) {
      enterStandaloneFhirViewer();
      return;
    }

    if (launchFromUrl) {
      persistLaunchToken(launchFromUrl);
      stripSensitiveQuery();
    }

    const launchToken = window.__RADSYSX_LAUNCH__ ? null : getStoredLaunchToken() ?? launchFromUrl;
    if (!launchToken && !window.__RADSYSX_LAUNCH__) {
      if (shouldUseStandaloneLocalViewer()) {
        await enterStandaloneLocalViewer();
        return;
      }
      throw new Error("The OHIF viewer requires a governed launch session.");
    }

    /** @type {SessionResponse} */
    const session = await requestJson("/api/auth/session");
    if (!session.authenticated || !session.session) {
      if (launchToken) {
        const preserved = persistLaunchToken(launchToken);
        if (!preserved) {
          clearStoredLaunchToken();
          throw new Error(
            "Sign-in is required, but the viewer could not preserve the governed launch for a login redirect.",
          );
        }
      }
      window.location.replace(
        `/login?next=${encodeURIComponent(window.__RADSYSX_VIEWER_BASE_PATH__ ?? "/")}`,
      );
      return;
    }

    /** @type {ImagingLaunchResolveResponse} */
    let resolved = window.__RADSYSX_LAUNCH__;
    if (!resolved) {
      try {
        resolved = await requestJson(
          `/api/imaging/launch/resolve?launch=${encodeURIComponent(launchToken ?? "")}`,
        );
      } catch (error) {
        clearStoredLaunchToken();
        throw error;
      }
    }

    window.__RADSYSX_LAUNCH__ = resolved;
    window.__RADSYSX_VIEWER_RUNTIME__ = resolved.viewerRuntime;
    window.__RADSYSX_VIEWER_BASE_PATH__ =
      normalizeViewerBasePath(resolved.viewerRuntime?.viewerBasePath) ??
      window.__RADSYSX_VIEWER_BASE_PATH__;
    applyResolvedViewerRuntime();
    window.__RADSYSX_CLEAN_VIEWER_URL__ = function cleanViewerUrl() {
      stripSensitiveQuery();
    };
    clearStoredLaunchToken();
    stripSensitiveQuery();
    if (loader) {
      loader.dataset.state = "ready";
      loader.querySelector("[data-role='title']").textContent = "Governed launch resolved";
      loader.querySelector("[data-role='body']").textContent =
        "Preparing the OHIF runtime and workspace panels.";
    }
  }

  function enterStandaloneFhirViewer() {
    window.__RADSYSX_FHIR_VIEWER__ = true;
    window.__RADSYSX_VIEWER_RUNTIME__ = {
      viewerKind: "ohif-fhir",
      viewerBasePath: window.__RADSYSX_VIEWER_BASE_PATH__ ?? "/viewer",
      featureFlags: {
        reportPanel: false,
        aiPanel: true,
        derivedPanel: false,
        auditPanel: false,
      },
    };
    window.__RADSYSX_CLEAN_VIEWER_URL__ = function preserveSmartLaunchQuery() {};
    window.__RADSYSX_FHIR_VIEWER_READY__ = true;
    removeBootstrapLoader();
  }

  async function enterStandaloneLocalViewer() {
    window.__RADSYSX_LOCAL_VIEWER__ = true;
    window.__RADSYSX_VIEWER_RUNTIME__ = {
      viewerKind: "ohif-local",
      viewerBasePath: window.__RADSYSX_VIEWER_BASE_PATH__ ?? "/viewer",
      qidoRoot: "/dicom-web",
      wadoRoot: "/dicom-web",
      wadoUriRoot: "/dicom-web",
      featureFlags: {
        reportPanel: false,
        aiPanel: false,
        derivedPanel: false,
        auditPanel: false,
      },
    };
    window.__RADSYSX_CLEAN_VIEWER_URL__ = function cleanLocalViewerUrl() {
      stripLocalStartQuery();
    };
    patchStandaloneLocalNavigation();
    installStandaloneLocalDropForwarder();

    if (hasDesktopLocalImport()) {
      try {
        await ensureDesktopLocalSession();
      } catch (error) {
        console.warn("Unable to pre-establish the optional desktop local session.", error);
      }
    }

    const relativeViewerPath = viewerRelativePath(window.location.pathname);
    if (localStartRequested || !isStandaloneLocalRoute(relativeViewerPath)) {
      window.__RADSYSX_LOCAL_VIEWER_READY__ = true;
      removeBootstrapLoader();
      window.location.replace(standaloneLocalStartUrl());
      return;
    }

    stripLocalStartQuery();
    if (loader) {
      loader.dataset.state = "local-viewer";
    }
    refreshStandaloneLocalChrome();
    window.__RADSYSX_LOCAL_VIEWER_READY__ = true;
    queueStandaloneLocalChromeRefresh();
    removeBootstrapLoader();
  }

  function installStandaloneLocalDropForwarder() {
    if (window.__RADSYSX_LOCAL_DROP_FORWARDER_INSTALLED__) {
      return;
    }
    window.__RADSYSX_LOCAL_DROP_FORWARDER_INSTALLED__ = true;

    document.addEventListener("dragover", (event) => {
      if (!shouldForwardStandaloneLocalDrop(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }, true);

    document.addEventListener("drop", (event) => {
      if (!shouldForwardStandaloneLocalDrop(event)) {
        return;
      }

      const input = standaloneLocalFileInput();
      if (!input) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      Object.defineProperty(input, "files", {
        configurable: true,
        value: event.dataTransfer.files,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, true);
  }

  function shouldForwardStandaloneLocalDrop(event) {
    return window.__RADSYSX_LOCAL_VIEWER__ === true &&
      viewerRelativePath(window.location.pathname) === "local" &&
      Boolean(event.dataTransfer) &&
      hasFileDataTransfer(event.dataTransfer);
  }

  function standaloneLocalFileInput() {
    return Array.from(document.querySelectorAll('input[type="file"]'))
      .find((candidate) => !candidate.webkitdirectory) ?? null;
  }

  function shouldUseStandaloneLocalViewer() {
    return localStartRequested ||
      hasDesktopLocalImport() ||
      isStandaloneLocalRoute(viewerRelativePath(window.location.pathname)) ||
      params.get("datasources") === "dicomlocal";
  }

  function isStandaloneFhirRoute(relativePath) {
    return relativePath.split("/")[0] === "fhir-viewer";
  }

  function isStandaloneLocalRoute(relativePath) {
    return ["local", "localbasic", "dicomlocal"].includes(relativePath.split("/")[0] ?? "");
  }

  function standaloneLocalStartUrl() {
    const basePath = normalizeViewerBasePath(window.__RADSYSX_VIEWER_BASE_PATH__) ?? "/viewer";
    return `${basePath === "/" ? "" : basePath}/local`;
  }

  function patchStandaloneLocalNavigation() {
    if (window.__RADSYSX_LOCAL_NAVIGATION_PATCHED__) {
      return;
    }
    window.__RADSYSX_LOCAL_NAVIGATION_PATCHED__ = true;

    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);

    history.pushState = function pushState(state, title, url) {
      const result = originalPushState(state, title, rewriteStandaloneLocalUrl(url));
      queueStandaloneLocalChromeRefresh();
      return result;
    };
    history.replaceState = function replaceState(state, title, url) {
      const result = originalReplaceState(state, title, rewriteStandaloneLocalUrl(url));
      queueStandaloneLocalChromeRefresh();
      return result;
    };
  }

  function rewriteStandaloneLocalUrl(url) {
    if (url == null) {
      return url;
    }

    const parsed = new URL(String(url), window.location.href);
    if (parsed.origin !== window.location.origin) {
      return url;
    }

    const basePath = normalizeViewerBasePath(window.__RADSYSX_VIEWER_BASE_PATH__) ?? "/viewer";
    const relativePath = viewerRelativePath(parsed.pathname, basePath);
    const hasLocalStudy =
      parsed.searchParams.get("datasources") === "dicomlocal" &&
      parsed.searchParams.has("StudyInstanceUIDs");

    if ((relativePath === "" && hasLocalStudy) || relativePath === "viewer/dicomlocal") {
      parsed.pathname = `${basePath === "/" ? "" : basePath}/dicomlocal`;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  function viewerRelativePath(pathname, basePath = window.__RADSYSX_VIEWER_BASE_PATH__ ?? "/viewer") {
    const normalizedBase = normalizeViewerBasePath(basePath) ?? "/viewer";
    const normalizedPath = `/${String(pathname ?? "").replace(/^\/+/, "")}`.replace(/\/+$/, "");
    if (normalizedPath === normalizedBase) {
      return "";
    }
    if (normalizedPath.startsWith(`${normalizedBase}/`)) {
      return normalizedPath.slice(normalizedBase.length + 1);
    }
    return normalizedPath.replace(/^\/+/, "");
  }

  function removeBootstrapLoader() {
    if (loader?.isConnected) {
      loader.remove();
    }
  }

  function queueStandaloneLocalChromeRefresh() {
    const refresh = () => {
      refreshStandaloneLocalChrome();
      window.setTimeout(refreshStandaloneLocalChrome, 120);
    };

    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(refresh);
      return;
    }

    window.setTimeout(refresh, 0);
  }

  function refreshStandaloneLocalChrome() {
    if (!document.body) {
      return;
    }

    if (!isStandaloneLocalLanding()) {
      document.body.classList.remove("radsysx-local-viewer");
      document.getElementById("radsysx-local-shell-backdrop")?.remove();
      const observer = window.__RADSYSX_LOCAL_UPLOAD_OBSERVER__;
      if (observer) {
        observer.disconnect();
        delete window.__RADSYSX_LOCAL_UPLOAD_OBSERVER__;
      }
      return;
    }

    document.body.classList.add("radsysx-local-viewer");
    ensureStandaloneLocalBackdrop();
    annotateStandaloneLocalUploadUi();
    installStandaloneLocalUploadObserver();
  }

  function isStandaloneLocalLanding() {
    return window.__RADSYSX_LOCAL_VIEWER__ === true &&
      viewerRelativePath(window.location.pathname) === "local";
  }

  function ensureStandaloneLocalBackdrop() {
    if (document.getElementById("radsysx-local-shell-backdrop")) {
      return;
    }

    const backdrop = document.createElement("div");
    backdrop.id = "radsysx-local-shell-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.innerHTML = `
      <div class="radsysx-local-shell-frame">
        <div class="radsysx-local-shell-topbar">
          <div class="radsysx-local-shell-brand"></div>
          <div class="radsysx-local-shell-pill">Local Viewer</div>
        </div>
        <div class="radsysx-local-shell-main">
          <aside class="radsysx-local-shell-panel">
            <div class="radsysx-local-shell-panel-title">Series</div>
            <div class="radsysx-local-shell-thumb"></div>
            <div class="radsysx-local-shell-thumb radsysx-local-shell-thumb-muted"></div>
            <div class="radsysx-local-shell-thumb radsysx-local-shell-thumb-muted"></div>
          </aside>
          <section class="radsysx-local-shell-viewport">
            <div class="radsysx-local-shell-scan"></div>
            <div class="radsysx-local-shell-overlay radsysx-local-shell-overlay-left"></div>
            <div class="radsysx-local-shell-overlay radsysx-local-shell-overlay-right"></div>
          </section>
          <aside class="radsysx-local-shell-panel radsysx-local-shell-ai">
            <div class="radsysx-local-shell-panel-title">RadSysX AI</div>
            <div class="radsysx-local-shell-line"></div>
            <div class="radsysx-local-shell-line radsysx-local-shell-line-short"></div>
            <div class="radsysx-local-shell-composer"></div>
          </aside>
        </div>
      </div>
    `;
    document.body.prepend(backdrop);
  }

  function installStandaloneLocalUploadObserver() {
    if (window.__RADSYSX_LOCAL_UPLOAD_OBSERVER__) {
      return;
    }

    const observer = new MutationObserver(() => {
      annotateStandaloneLocalUploadUi();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__RADSYSX_LOCAL_UPLOAD_OBSERVER__ = observer;
  }

  function annotateStandaloneLocalUploadUi() {
    const loadButtons = Array.from(document.querySelectorAll("button"))
      .filter((button) => ["Load files", "Load folders"].includes(button.textContent?.trim() ?? ""));
    if (!loadButtons.length) {
      return false;
    }

    let modal = loadButtons[0].parentElement;
    for (let depth = 0; modal && modal !== document.body && depth < 8; depth += 1) {
      const className = String(modal.getAttribute("class") ?? "");
      if (modal.classList.contains("bg-muted") || className.includes("border-dashed")) {
        break;
      }
      modal = modal.parentElement;
    }

    if (!modal || modal === document.body) {
      return false;
    }

    modal.dataset.radsysxLocalUploadModal = "true";
    const screen = modal.closest(".h-screen") ?? modal.parentElement;
    if (screen) {
      screen.dataset.radsysxLocalUploadScreen = "true";
    }

    const logo = modal.querySelector("svg")?.parentElement;
    if (logo) {
      logo.dataset.radsysxLocalUploadLogo = "true";
    }

    return true;
  }

  async function requestJson(path, init = {}) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(path, {
        credentials: "include",
        signal: controller.signal,
        ...init,
        headers: {
          ...(init.headers ?? {}),
        },
      });

      if (!response.ok) {
        const detail = (await response.text()) || `Request failed with ${response.status}`;
        throw new Error(detail);
      }

      return response.json();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Viewer bootstrap timed out while contacting the backend.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function hasDesktopLocalImport() {
    return typeof window.radsysxDesktop?.importLocalImaging === "function";
  }

  async function ensureDesktopLocalSession() {
    /** @type {SessionResponse} */
    const session = await requestJson("/api/auth/session");
    if (session.authenticated && session.session) {
      return;
    }

    await requestJson("/api/auth/local-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "demo-radiologist" }),
    });
  }

  function showLocalStart() {
    stripLocalStartQuery();
    loader.dataset.state = "local-start";
    loader.innerHTML = `
      <div class="radsysx-loader-card radsysx-local-start-card" data-testid="radsysx-local-start-card">
        <div class="radsysx-loader-kicker">RadSysX Local Viewer</div>
        <div class="radsysx-loader-title" data-role="title">Open a local study</div>
        <div class="radsysx-loader-body" data-role="body">
          Open or drop a local DICOM, DICOMDIR, NIFTI, NRRD, image, or ZIP. DICOM opens here in OHIF immediately after import.
        </div>
        <div class="radsysx-local-start-actions">
          <button class="radsysx-local-start-primary" type="button" data-testid="radsysx-local-import-files" data-mode="files">Open local study</button>
          <button class="radsysx-local-start-secondary" type="button" data-testid="radsysx-local-import-folder" data-mode="folder">Choose folder</button>
        </div>
        <div class="radsysx-local-start-status" data-testid="radsysx-local-import-status" aria-live="polite"></div>
      </div>
    `;
    window.__RADSYSX_LOCAL_START_READY__ = true;

    for (const button of loader.querySelectorAll("[data-mode]")) {
      button.addEventListener("click", () => {
        const mode = button.getAttribute("data-mode") === "folder" ? "folder" : "files";
        void importLocalImagingFromDesktop(mode);
      });
    }

    const card = loader.querySelector("[data-testid='radsysx-local-start-card']");
    if (card) {
      card.addEventListener("dragenter", handleLocalStartDragEnter);
      card.addEventListener("dragover", handleLocalStartDragOver);
      card.addEventListener("dragleave", handleLocalStartDragLeave);
      card.addEventListener("drop", (event) => {
        void handleLocalStartDrop(event);
      });
    }

    const primaryButton = loader.querySelector("[data-testid='radsysx-local-import-files']");
    if (primaryButton instanceof HTMLButtonElement) {
      primaryButton.focus({ preventScroll: true });
    }
  }

  function setLocalStartImporting(importing, statusText) {
    const buttons = Array.from(loader.querySelectorAll("[data-mode]"));
    const card = loader.querySelector("[data-testid='radsysx-local-start-card']");
    const status = loader.querySelector("[data-testid='radsysx-local-import-status']");
    for (const button of buttons) {
      button.disabled = importing;
    }
    if (card) {
      card.dataset.importing = importing ? "true" : "false";
    }
    if (status) {
      status.textContent = statusText ?? "";
    }
    return { buttons, card, status };
  }

  async function importLocalImagingFromDesktop(mode) {
    setLocalStartImporting(
      true,
      mode === "folder" ? "Importing local folder..." : "Importing local files...",
    );

    try {
      const result = await window.radsysxDesktop.importLocalImaging({ mode });
      if (result.cancelled) {
        if (status) {
          status.textContent = "Import cancelled.";
        }
        return;
      }
      if (!result.response) {
        throw new Error("Local import did not return a backend response.");
      }
      await openImportedStudy(result.response);
    } catch (error) {
      setLocalStartStatus(error instanceof Error ? error.message : "Unable to import local imaging files.");
    } finally {
      setLocalStartImporting(false, readLocalStartStatus());
    }
  }

  function handleLocalStartDragEnter(event) {
    if (!event.dataTransfer || !hasFileDataTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    const card = loader.querySelector("[data-testid='radsysx-local-start-card']");
    if (card) {
      card.dataset.dragging = "true";
    }
    setLocalStartStatus("Release to import local study.");
  }

  function handleLocalStartDragOver(event) {
    if (!event.dataTransfer || !hasFileDataTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleLocalStartDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    const card = loader.querySelector("[data-testid='radsysx-local-start-card']");
    const nextTarget = event.relatedTarget;
    if (card && (!(nextTarget instanceof Node) || !card.contains(nextTarget))) {
      delete card.dataset.dragging;
      if (readLocalStartStatus() === "Release to import local study.") {
        setLocalStartStatus("");
      }
    }
  }

  async function handleLocalStartDrop(event) {
    if (!event.dataTransfer || !hasFileDataTransfer(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const card = loader.querySelector("[data-testid='radsysx-local-start-card']");
    if (card) {
      delete card.dataset.dragging;
    }
    setLocalStartImporting(true, "Importing dropped local study...");

    try {
      const files = await filesFromDataTransfer(event.dataTransfer);
      if (!files.length) {
        throw new Error("No local imaging files were dropped.");
      }
      const response = await importLocalFilesThroughBackend(files);
      await openImportedStudy(response);
    } catch (error) {
      setLocalStartStatus(error instanceof Error ? error.message : "Unable to import dropped local imaging files.");
    } finally {
      setLocalStartImporting(false, readLocalStartStatus());
    }
  }

  function hasFileDataTransfer(dataTransfer) {
    return Array.from(dataTransfer.types ?? []).includes("Files") ||
      Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file") ||
      dataTransfer.files?.length > 0;
  }

  async function importLocalFilesThroughBackend(files) {
    const form = new FormData();
    const relativePaths = [];
    for (const file of files) {
      const relativePath = readBrowserRelativePath(file);
      relativePaths.push(relativePath);
      form.append("files", file, relativePath);
    }
    form.set("relativePaths", JSON.stringify(relativePaths));
    return requestJson("/api/local-imaging/import", {
      method: "POST",
      body: form,
    });
  }

  async function filesFromDataTransfer(dataTransfer) {
    const itemEntries = Array.from(dataTransfer.items ?? [])
      .filter((item) => item.kind === "file")
      .map(getBrowserFileSystemEntry)
      .filter(isBrowserFileSystemEntry);

    if (!itemEntries.length) {
      return Array.from(dataTransfer.files ?? []);
    }

    const files = await Promise.all(itemEntries.map((entry) => filesFromEntry(entry)));
    return files.flat();
  }

  async function filesFromEntry(entry, parentRelativePath = "") {
    const relativePath = joinRelativePath(parentRelativePath, entry.name);

    if (entry.isFile) {
      return [await fileFromFileEntry(entry, relativePath)];
    }

    if (!entry.isDirectory) {
      return [];
    }

    const childEntries = await readDirectoryEntries(entry);
    const nestedFiles = await Promise.all(
      childEntries.map((childEntry) => filesFromEntry(childEntry, relativePath)),
    );
    return nestedFiles.flat();
  }

  function fileFromFileEntry(entry, relativePath) {
    return new Promise((resolve, reject) => {
      entry.file(
        (file) => resolve(fileWithRelativePath(file, relativePath || file.name)),
        reject,
      );
    });
  }

  function readDirectoryEntries(entry) {
    const reader = entry.createReader();
    const entries = [];

    return new Promise((resolve, reject) => {
      const readBatch = () => {
        reader.readEntries((batch) => {
          if (!batch.length) {
            resolve(entries);
            return;
          }
          entries.push(...batch);
          readBatch();
        }, reject);
      };

      readBatch();
    });
  }

  function getBrowserFileSystemEntry(item) {
    const entry = item.webkitGetAsEntry?.() ?? null;
    return isBrowserFileSystemEntry(entry) ? entry : null;
  }

  function isBrowserFileSystemEntry(entry) {
    return Boolean(
      entry &&
        typeof entry === "object" &&
        "name" in entry &&
        "isFile" in entry &&
        "isDirectory" in entry &&
        typeof entry.name === "string" &&
        typeof entry.isFile === "boolean" &&
        typeof entry.isDirectory === "boolean",
    );
  }

  function fileWithRelativePath(file, relativePath) {
    Object.defineProperty(file, DROP_RELATIVE_PATH_KEY, {
      configurable: true,
      value: relativePath || file.name,
    });
    return file;
  }

  function readBrowserRelativePath(file) {
    const relativePath = file[DROP_RELATIVE_PATH_KEY] ?? file.webkitRelativePath;
    return relativePath && relativePath.trim() ? relativePath : file.name;
  }

  function joinRelativePath(parentPath, name) {
    const cleanParent = parentPath.replace(/^\/+|\/+$/g, "");
    const cleanName = name.replace(/^\/+|\/+$/g, "");
    return cleanParent ? `${cleanParent}/${cleanName}` : cleanName;
  }

  function setLocalStartStatus(message) {
    const status = loader.querySelector("[data-testid='radsysx-local-import-status']");
    if (status) {
      status.textContent = message;
    }
  }

  function readLocalStartStatus() {
    return loader.querySelector("[data-testid='radsysx-local-import-status']")?.textContent ?? "";
  }

  async function openImportedStudy(response) {
    const importedStudies = response.importedStudies ?? [];
    const dicomStudy = importedStudies.find((study) =>
      Array.isArray(study.formats) && study.formats.includes("dicom")
    );
    if (dicomStudy) {
      const status = loader.querySelector("[data-testid='radsysx-local-import-status']");
      if (status) {
        status.textContent = "Opening imported DICOM study in OHIF...";
      }
      /** @type {ImagingLaunchResponse} */
      const launch = await requestJson("/api/imaging/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ studyInstanceUID: dicomStudy.studyInstanceUID }),
      });
      window.location.assign(launch.viewerUrl);
      return;
    }

    const firstStudy = importedStudies[0];
    if (firstStudy?.studyInstanceUID) {
      try {
        window.sessionStorage.setItem(LOCAL_START_INSPECT_KEY, firstStudy.studyInstanceUID);
      } catch (error) {
        console.warn("Unable to preserve imported local study for inspection.", error);
      }
    }
    window.location.assign("/worklist");
  }

  function stripSensitiveQuery() {
    const cleanParams = new URLSearchParams(window.location.search);
    cleanParams.delete("launch");
    cleanParams.delete("_rsc");
    cleanParams.delete("StudyInstanceUIDs");
    cleanParams.delete("studyInstanceUIDs");
    cleanParams.delete("SeriesInstanceUIDs");
    cleanParams.delete("seriesInstanceUIDs");
    const nextUrl = cleanParams.toString()
      ? `${window.location.pathname}?${cleanParams.toString()}`
      : window.location.pathname;
    history.replaceState(history.state, "", nextUrl);
  }

  function stripLocalStartQuery() {
    const cleanParams = new URLSearchParams(window.location.search);
    cleanParams.delete("local");
    const nextUrl = cleanParams.toString()
      ? `${window.location.pathname}?${cleanParams.toString()}`
      : window.location.pathname;
    history.replaceState(history.state, "", nextUrl);
  }

  function applyResolvedViewerRuntime() {
    const runtime = window.__RADSYSX_VIEWER_RUNTIME__;
    const config = window.config;
    if (!runtime || !config) {
      return;
    }

    config.routerBasename = window.__RADSYSX_VIEWER_BASE_PATH__ ?? config.routerBasename;

    const dicomwebSource = config.dataSources?.find((entry) => entry?.sourceName === "dicomweb");
    if (!dicomwebSource?.configuration) {
      return;
    }

    dicomwebSource.configuration.qidoRoot = normalizeSameOriginUrl(runtime.qidoRoot);
    dicomwebSource.configuration.wadoRoot = normalizeSameOriginUrl(runtime.wadoRoot);
    dicomwebSource.configuration.wadoUriRoot = normalizeSameOriginUrl(runtime.wadoUriRoot);
    if (runtime.featureFlags?.directStow && runtime.stowRoot) {
      dicomwebSource.configuration.stowRoot = normalizeSameOriginUrl(runtime.stowRoot);
    } else {
      delete dicomwebSource.configuration.stowRoot;
    }
  }

  function persistLaunchToken(token) {
    try {
      window.sessionStorage.setItem(LAUNCH_STORAGE_KEY, token);
      return true;
    } catch (error) {
      console.warn("Unable to persist launch token for login handoff.", error);
      return false;
    }
  }

  function getStoredLaunchToken() {
    try {
      return window.sessionStorage.getItem(LAUNCH_STORAGE_KEY);
    } catch (error) {
      console.warn("Unable to read stored launch token.", error);
      return null;
    }
  }

  function clearStoredLaunchToken() {
    try {
      window.sessionStorage.removeItem(LAUNCH_STORAGE_KEY);
    } catch (error) {
      console.warn("Unable to clear stored launch token.", error);
    }
  }

  function resolveViewerBasePath(value) {
    const normalized = normalizeViewerBasePath(value);
    if (!normalized) {
      return null;
    }

    const parts = normalized.split("/").filter(Boolean);
    if (parts[0] === "viewer") {
      return "/viewer";
    }
    return normalized;
  }

  function normalizeViewerBasePath(value) {
    if (!value) {
      return null;
    }

    const trimmed = String(value).trim();
    if (!trimmed) {
      return null;
    }

    const normalized = `/${trimmed.replace(/^\/+/, "")}`.replace(/\/+$/, "");
    return normalized || "/";
  }

  function enforceRadSysXTitle() {
    const desiredTitle = "RadSysX";
    const setTitle = () => {
      if (document.title !== desiredTitle) {
        document.title = desiredTitle;
      }
    };

    setTitle();

    let titleElement = document.querySelector("title");
    if (!titleElement) {
      titleElement = document.createElement("title");
      document.head?.appendChild(titleElement);
    }

    if (titleElement) {
      const observer = new MutationObserver(setTitle);
      observer.observe(titleElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    window.addEventListener("load", setTitle, { once: true });
    window.setTimeout(setTitle, 250);
    window.setTimeout(setTitle, 1200);
  }

  function normalizeSameOriginUrl(value) {
    if (!value) {
      return value;
    }
    if (/^https?:\/\//i.test(value)) {
      return value;
    }
    if (value.startsWith("/")) {
      return `${window.location.origin}${value}`;
    }
    return value;
  }

  async function ensureLoader() {
    const existing = document.getElementById("radsysx-loader");
    if (existing) {
      return existing;
    }

    if (!document.body) {
      await new Promise((resolve) => {
        if (document.body) {
          resolve(undefined);
          return;
        }

        document.addEventListener("DOMContentLoaded", () => resolve(undefined), { once: true });
      });
    }

    const element = document.createElement("div");
    element.id = "radsysx-loader";
    element.innerHTML = `
      <div class="radsysx-loader-card">
        <div class="radsysx-loader-kicker">RadSysX Clinical Viewer</div>
        <div class="radsysx-loader-title" data-role="title">Resolving governed launch</div>
        <div class="radsysx-loader-body" data-role="body">Preparing the OHIF runtime...</div>
      </div>
    `;
    (document.body ?? document.documentElement).appendChild(element);
    return element;
  }

  function fail(message) {
    loader.dataset.state = "error";
    loader.querySelector("[data-role='title']").textContent = "Viewer bootstrap failed";
    loader.querySelector("[data-role='body']").textContent = message;
  }
})();
