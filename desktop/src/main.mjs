import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(__filename), "..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const preloadPath = path.join(desktopRoot, "src", "preload.cjs");
const logoPath = path.join(workspaceRoot, "RadSysX-Logo.png");
const logoLightPath = path.join(workspaceRoot, "RadSysX-Logo-Light.png");
const viewerDist = path.join(workspaceRoot, "viewer", "dist");
const viewerRoot = path.join(workspaceRoot, "viewer");
const viewerAssetNames = [
  "radsysx-bootstrap.js",
  "radsysx-ohif-extension.js",
  "radsysx-ohif-mode.js",
  "radsysx-viewer.css",
];
const frontendBuildId = path.join(workspaceRoot, "frontend", ".next", "BUILD_ID");
const frontendDesktopBuildStamp = path.join(workspaceRoot, "frontend", ".next", "radsysx-desktop-build.json");
const frontendStandaloneServer = path.join(
  workspaceRoot,
  "frontend",
  ".next",
  "standalone",
  "frontend",
  "server.js",
);
const frontendStandaloneRoot = path.dirname(frontendStandaloneServer);
const frontendStaticSource = path.join(workspaceRoot, "frontend", ".next", "static");
const frontendStaticTarget = path.join(frontendStandaloneRoot, ".next", "static");
const frontendPublicSource = path.join(workspaceRoot, "frontend", "public");
const frontendPublicTarget = path.join(frontendStandaloneRoot, "public");

const DEFAULT_APP_PORT = Number.parseInt(process.env.RADSYSX_DESKTOP_PORT ?? "3000", 10);
const DEFAULT_FRONTEND_PORT = Number.parseInt(process.env.RADSYSX_DESKTOP_FRONTEND_PORT ?? "3010", 10);
const DEFAULT_BACKEND_PORT = Number.parseInt(process.env.RADSYSX_DESKTOP_BACKEND_PORT ?? "8000", 10);
const DEFAULT_DESKTOP_START_PATH = "/viewer/local";
const DESKTOP_FRONTEND_MODE = normalizeFrontendMode(process.env.RADSYSX_DESKTOP_FRONTEND_MODE);
const DESKTOP_PICKER_MAX_FILES = Number.parseInt(process.env.RADSYSX_DESKTOP_PICKER_MAX_FILES ?? "500", 10);
const DESKTOP_PICKER_MAX_BYTES = Number.parseInt(
  process.env.RADSYSX_DESKTOP_PICKER_MAX_BYTES ?? String(1024 * 1024 * 1024),
  10,
);
const LOCAL_IMAGING_EXTENSIONS = new Set([
  ".bmp",
  ".dcm",
  ".dicom",
  ".gif",
  ".hdr",
  ".img",
  ".jpg",
  ".jpeg",
  ".nii",
  ".nrrd",
  ".png",
  ".tif",
  ".tiff",
  ".zip",
]);

const children = new Set();
const logLines = [];
let shuttingDown = false;
let shutdownStarted = false;
let smokeExitScheduled = false;
let bridgeServer = null;
let mainWindow = null;
let publicBaseUrl = null;

function appendLog(scope, message) {
  const lines = String(message)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    const entry = `[${scope}] ${line}`;
    console.log(entry);
    logLines.push(entry);
  }

  while (logLines.length > 240) {
    logLines.shift();
  }
}

function recentLogs() {
  return logLines.slice(-80).join("\n");
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function nodeCommand() {
  return process.platform === "win32" ? "node.exe" : "node";
}

function normalizeFrontendMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "development" || mode === "dev") {
    return "development";
  }
  return "production";
}

function desktopStartUrl(baseUrl = publicBaseUrl) {
  if (!baseUrl) {
    return null;
  }

  const rawPath = process.env.RADSYSX_DESKTOP_START_PATH ?? DEFAULT_DESKTOP_START_PATH;
  try {
    const url = new URL(rawPath, baseUrl);
    if (url.origin !== baseUrl) {
      return `${baseUrl}${DEFAULT_DESKTOP_START_PATH}`;
    }
    return url.href;
  } catch {
    return `${baseUrl}${DEFAULT_DESKTOP_START_PATH}`;
  }
}

function isLocalImagingFile(filePath) {
  const fileName = path.basename(filePath);
  if (fileName.toUpperCase() === "DICOMDIR") {
    return true;
  }
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".nii.gz")) {
    return true;
  }
  const extension = path.extname(lowerName);
  if (!extension && !fileName.startsWith(".")) {
    return true;
  }
  return LOCAL_IMAGING_EXTENSIONS.has(extension);
}

function guessContentType(filePath) {
  const fileName = path.basename(filePath).toLowerCase();
  if (fileName.endsWith(".nii") || fileName.endsWith(".nii.gz")) {
    return "application/octet-stream";
  }
  if (fileName.endsWith(".nrrd")) {
    return "application/octet-stream";
  }
  if (fileName.endsWith(".png")) {
    return "image/png";
  }
  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (fileName.endsWith(".tif") || fileName.endsWith(".tiff")) {
    return "image/tiff";
  }
  if (fileName.endsWith(".bmp")) {
    return "image/bmp";
  }
  if (fileName.endsWith(".gif")) {
    return "image/gif";
  }
  if (fileName.endsWith(".zip")) {
    return "application/zip";
  }
  return "application/dicom";
}

async function collectPickedFiles(pathsToImport) {
  const selectedEntries = await collectPickedFileEntries(pathsToImport);
  return Promise.all(selectedEntries.map(readPickedFile));
}

async function collectPickedFileEntries(pathsToImport) {
  const selectedFiles = [];
  let totalBytes = 0;

  for (const selectedPath of pathsToImport) {
    const stats = await fs.promises.stat(selectedPath);
    if (stats.isDirectory()) {
      for await (const filePath of walkDirectory(selectedPath)) {
        if (!isLocalImagingFile(filePath)) {
          continue;
        }
        const fileStats = await fs.promises.stat(filePath);
        totalBytes += fileStats.size;
        enforcePickerLimits(selectedFiles.length + 1, totalBytes);
        selectedFiles.push(
          pickedFileEntry(
            filePath,
            path.join(path.basename(selectedPath), path.relative(selectedPath, filePath)),
            fileStats,
          ),
        );
      }
      continue;
    }

    if (!stats.isFile() || !isLocalImagingFile(selectedPath)) {
      continue;
    }
    totalBytes += stats.size;
    enforcePickerLimits(selectedFiles.length + 1, totalBytes);
    selectedFiles.push(pickedFileEntry(selectedPath, path.basename(selectedPath), stats));
  }

  return selectedFiles;
}

function readPickerTestPaths() {
  if (process.env.RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN !== "1") {
    return null;
  }

  const rawPaths = process.env.RADSYSX_DESKTOP_PICKER_TEST_PATHS;
  if (!rawPaths) {
    return null;
  }

  let parsedPaths;
  try {
    parsedPaths = JSON.parse(rawPaths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid RADSYSX_DESKTOP_PICKER_TEST_PATHS JSON: ${message}`);
  }

  if (
    !Array.isArray(parsedPaths) ||
    parsedPaths.length === 0 ||
    parsedPaths.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error("RADSYSX_DESKTOP_PICKER_TEST_PATHS must be a non-empty JSON array of paths.");
  }

  return parsedPaths;
}

async function* walkDirectory(root) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkDirectory(filePath);
    } else if (entry.isFile()) {
      yield filePath;
    }
  }
}

function enforcePickerLimits(fileCount, totalBytes) {
  if (fileCount > DESKTOP_PICKER_MAX_FILES) {
    throw new Error(`The desktop picker limit is ${DESKTOP_PICKER_MAX_FILES} files.`);
  }
  if (totalBytes > DESKTOP_PICKER_MAX_BYTES) {
    throw new Error(`The desktop picker limit is ${Math.round(DESKTOP_PICKER_MAX_BYTES / 1024 / 1024)} MB.`);
  }
}

function pickedFileEntry(filePath, relativePath, stats) {
  return {
    name: path.basename(filePath),
    filePath,
    relativePath: relativePath.split(path.sep).join("/"),
    type: guessContentType(filePath),
    size: stats.size,
    lastModified: stats.mtimeMs,
  };
}

async function readPickedFile(entry) {
  const data = await fs.promises.readFile(entry.filePath);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return {
    name: entry.name,
    relativePath: entry.relativePath,
    type: entry.type,
    size: entry.size,
    lastModified: entry.lastModified,
    data: buffer,
  };
}

async function importPickedFilesThroughBackend(sender, pathsToImport) {
  if (!publicBaseUrl) {
    throw new Error("RadSysX desktop runtime is not ready for local imaging import.");
  }

  const selectedEntries = await collectPickedFileEntries(pathsToImport);
  if (!selectedEntries.length) {
    throw new Error("No supported local imaging files were selected.");
  }

  const form = new FormData();
  const relativePaths = [];
  for (const entry of selectedEntries) {
    const blob = await fs.openAsBlob(entry.filePath, { type: entry.type });
    relativePaths.push(entry.relativePath);
    form.append("files", blob, entry.relativePath);
  }
  form.set("relativePaths", JSON.stringify(relativePaths));

  const cookieHeader = await cookieHeaderForSender(sender);
  const response = await fetch(`${publicBaseUrl}/api/local-imaging/import`, {
    method: "POST",
    body: form,
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(payload || `Local imaging import failed: ${response.status}`);
  }

  return response.json();
}

async function cookieHeaderForSender(sender) {
  if (!publicBaseUrl) {
    return "";
  }

  const cookies = await sender.session.cookies.get({ url: publicBaseUrl });
  return cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function pythonCommand() {
  const configuredPython = process.env.RADSYSX_DESKTOP_PYTHON ?? process.env.PYTHON;
  if (configuredPython) {
    return configuredPython;
  }

  const venvPython = venvPythonPath();
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return process.platform === "win32" ? "python" : "python3";
}

function venvPythonPath() {
  return process.platform === "win32"
    ? path.join(workspaceRoot, ".venv", "Scripts", "python.exe")
    : path.join(workspaceRoot, ".venv", "bin", "python");
}

async function findAvailablePort(preferredPort, usedPorts = new Set()) {
  for (let candidate = preferredPort; candidate < preferredPort + 100; candidate += 1) {
    if (usedPorts.has(candidate)) {
      continue;
    }
    if (await canListen(candidate)) {
      usedPorts.add(candidate);
      return candidate;
    }
  }

  throw new Error(`Unable to find an available local port near ${preferredPort}.`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function spawnService(name, command, args, options = {}) {
  appendLog(name, `${command} ${args.join(" ")}`);

  const child = spawn(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  children.add(child);

  child.stdout?.on("data", (chunk) => appendLog(name, chunk));
  child.stderr?.on("data", (chunk) => appendLog(name, chunk));
  child.once("exit", (code, signal) => {
    children.delete(child);
    appendLog(name, `exited with ${signal ?? code ?? "unknown"}`);
    if (!shuttingDown && code && code !== 0) {
      showRuntimeFailure(`${name} stopped unexpectedly.`, recentLogs());
    }
  });

  child.once("error", (error) => {
    children.delete(child);
    appendLog(name, error.message);
    if (!shuttingDown) {
      showRuntimeFailure(`Unable to start ${name}.`, recentLogs());
    }
  });

  return child;
}

function stopChild(child) {
  if (!child.pid || child.killed) {
    return;
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }

  setTimeout(() => {
    if (child.killed) {
      return;
    }
    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      // Process already exited.
    }
  }, 4000).unref();
}

async function runTask(name, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnService(name, command, args, options);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${name} failed with ${signal ?? code ?? "unknown"}.`));
    });
    child.once("error", reject);
  });
}

async function waitForHttp(url, label, timeoutMs = 120000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.status < 500) {
        appendLog("desktop", `${label} is ready at ${url}`);
        return;
      }
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  throw new Error(
    `${label} did not become ready at ${url}.${lastError ? ` Last error: ${lastError.message}` : ""}`,
  );
}

async function ensureViewerDist(env) {
  const indexPath = path.join(viewerDist, "index.html");
  if (viewerDistIsFresh(indexPath)) {
    appendLog("viewer", "using existing viewer/dist");
    return;
  }

  appendLog("viewer", "viewer/dist is missing or stale; building OHIF distribution");
  await runTask("viewer", npmCommand(), ["run", "build", "--workspace", "viewer"], {
    cwd: workspaceRoot,
    env,
  });
}

function viewerDistIsFresh(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return false;
  }

  const appConfigPath = path.join(viewerDist, "app-config.js");
  if (!fs.existsSync(appConfigPath)) {
    return false;
  }

  const buildScriptPath = path.join(viewerRoot, "scripts", "build-ohif-dist.mjs");
  if (isNewerThan(buildScriptPath, appConfigPath)) {
    return false;
  }

  for (const assetName of viewerAssetNames) {
    const sourcePath = path.join(viewerRoot, "assets", assetName);
    const outputPath = path.join(viewerDist, assetName);
    if (!fs.existsSync(outputPath) || isNewerThan(sourcePath, outputPath)) {
      return false;
    }
  }

  return true;
}

function isNewerThan(sourcePath, targetPath) {
  try {
    return fs.statSync(sourcePath).mtimeMs > fs.statSync(targetPath).mtimeMs;
  } catch {
    return true;
  }
}

function frontendBuildSettings(env) {
  return {
    nextPublicBackendUrl: env.NEXT_PUBLIC_BACKEND_URL,
    nextPublicViewerBaseUrl: env.NEXT_PUBLIC_VIEWER_BASE_URL,
    nextPublicRadsysxAppMode: env.NEXT_PUBLIC_RADSYSX_APP_MODE,
  };
}

function readFrontendBuildStamp() {
  try {
    return JSON.parse(fs.readFileSync(frontendDesktopBuildStamp, "utf-8"));
  } catch {
    return null;
  }
}

function frontendBuildMatches(env) {
  if (!fs.existsSync(frontendBuildId) || !fs.existsSync(frontendStandaloneServer)) {
    return false;
  }
  const current = readFrontendBuildStamp();
  return JSON.stringify(current) === JSON.stringify(frontendBuildSettings(env));
}

function syncFrontendStandaloneAssets({ force = false } = {}) {
  if (fs.existsSync(frontendStaticSource) && (force || !fs.existsSync(frontendStaticTarget))) {
    fs.rmSync(frontendStaticTarget, { force: true, recursive: true });
    fs.mkdirSync(path.dirname(frontendStaticTarget), { recursive: true });
    fs.cpSync(frontendStaticSource, frontendStaticTarget, { recursive: true });
  }

  if (fs.existsSync(frontendPublicSource) && (force || !fs.existsSync(frontendPublicTarget))) {
    fs.rmSync(frontendPublicTarget, { force: true, recursive: true });
    fs.cpSync(frontendPublicSource, frontendPublicTarget, { recursive: true });
  }
}

async function ensureFrontendBuild(env) {
  if (DESKTOP_FRONTEND_MODE === "development") {
    appendLog("frontend", "using Next.js development server");
    return;
  }

  if (process.env.RADSYSX_DESKTOP_REBUILD_FRONTEND !== "1" && frontendBuildMatches(env)) {
    syncFrontendStandaloneAssets();
    appendLog("frontend", "using existing desktop Next.js production build");
    return;
  }

  appendLog("frontend", "building Next.js production shell for desktop");
  await runTask("frontend-build", npmCommand(), ["run", "build", "--workspace", "frontend"], {
    cwd: workspaceRoot,
    env,
  });
  syncFrontendStandaloneAssets({ force: true });
  fs.mkdirSync(path.dirname(frontendDesktopBuildStamp), { recursive: true });
  fs.writeFileSync(frontendDesktopBuildStamp, JSON.stringify(frontendBuildSettings(env), null, 2), "utf-8");
}

function frontendService(frontendPort) {
  if (DESKTOP_FRONTEND_MODE === "development") {
    return {
      command: npmCommand(),
      args: [
        "run",
        "dev",
        "--workspace",
        "frontend",
        "--",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(frontendPort),
      ],
      env: {},
    };
  }

  return {
    command: nodeCommand(),
    args: [frontendStandaloneServer],
    env: {
      HOSTNAME: "127.0.0.1",
      PORT: String(frontendPort),
    },
  };
}

async function startRuntime() {
  const usedPorts = new Set();
  const appPort = await findAvailablePort(DEFAULT_APP_PORT, usedPorts);
  const backendPort = await findAvailablePort(DEFAULT_BACKEND_PORT, usedPorts);
  const frontendPort = await findAvailablePort(DEFAULT_FRONTEND_PORT, usedPorts);

  publicBaseUrl = `http://127.0.0.1:${appPort}`;
  const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
  const frontendBaseUrl = `http://127.0.0.1:${frontendPort}`;

  const sharedEnv = {
    RADSYSX_APP_MODE: process.env.RADSYSX_APP_MODE ?? "pilot",
    RADSYSX_AUTH_MODE: process.env.RADSYSX_AUTH_MODE ?? "local",
    RADSYSX_ALLOWED_ORIGINS:
      process.env.RADSYSX_ALLOWED_ORIGINS ?? `${publicBaseUrl},http://localhost:${appPort}`,
    RADSYSX_CLINICAL_API_SECRET:
      process.env.RADSYSX_CLINICAL_API_SECRET ?? "radsysx-desktop-local-api-secret",
    RADSYSX_SESSION_SECRET:
      process.env.RADSYSX_SESSION_SECRET ?? "radsysx-desktop-local-session-secret",
    RADSYSX_SESSION_COOKIE_SECURE: process.env.RADSYSX_SESSION_COOKIE_SECURE ?? "false",
    RADSYSX_VIEWER_BASE_URL: process.env.RADSYSX_VIEWER_BASE_URL ?? `${publicBaseUrl}/viewer`,
    RADSYSX_VIEWER_BASE_PATH: process.env.RADSYSX_VIEWER_BASE_PATH ?? "/viewer",
    RADSYSX_DICOMWEB_PUBLIC_BASE_URL:
      process.env.RADSYSX_DICOMWEB_PUBLIC_BASE_URL ?? "/dicom-web",
    RADSYSX_LOCAL_IMAGING_ENABLED: process.env.RADSYSX_LOCAL_IMAGING_ENABLED ?? "true",
    RADSYSX_LOCAL_IMAGING_STORAGE_DIR:
      process.env.RADSYSX_LOCAL_IMAGING_STORAGE_DIR ??
      path.join(workspaceRoot, "backend", "local-imaging-data"),
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL ?? "",
    NEXT_PUBLIC_VIEWER_BASE_URL: process.env.NEXT_PUBLIC_VIEWER_BASE_URL ?? "/viewer",
    NEXT_PUBLIC_RADSYSX_APP_MODE:
      process.env.NEXT_PUBLIC_RADSYSX_APP_MODE ?? (process.env.RADSYSX_APP_MODE ?? "pilot"),
  };

  await ensureViewerDist(sharedEnv);
  await ensureFrontendBuild(sharedEnv);

  bridgeServer = await startDesktopBridge({
    appPort,
    backendBaseUrl,
    frontendBaseUrl,
  });

  spawnService(
    "backend",
    pythonCommand(),
    [
      "-m",
      "uvicorn",
      "backend.server:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(backendPort),
      "--no-access-log",
    ],
    {
      cwd: workspaceRoot,
      env: sharedEnv,
    },
  );

  const frontend = frontendService(frontendPort);
  spawnService("frontend", frontend.command, frontend.args, {
    cwd: workspaceRoot,
    env: {
      ...sharedEnv,
      ...frontend.env,
    },
  });

  await Promise.all([
    waitForHttp(`${backendBaseUrl}/api/platform/config`, "FastAPI backend"),
    waitForHttp(frontendBaseUrl, "Next.js shell"),
  ]);

  appendLog("desktop", `RadSysX desktop is ready at ${publicBaseUrl}`);
  return { publicBaseUrl };
}

function startDesktopBridge({ appPort, backendBaseUrl, frontendBaseUrl }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      handleBridgeRequest(request, response, {
        backendBaseUrl,
        frontendBaseUrl,
      });
    });
    server.on("upgrade", (request, socket, head) => {
      handleBridgeUpgrade(request, socket, head, {
        backendBaseUrl,
        frontendBaseUrl,
      });
    });

    server.once("error", reject);
    server.listen(appPort, "127.0.0.1", () => {
      appendLog("desktop", `local bridge listening on http://127.0.0.1:${appPort}`);
      resolve(server);
    });
  });
}

function handleBridgeRequest(request, response, runtime) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = requestUrl.pathname;

  if (pathname === "/_radsysx/desktop/health") {
    writeJson(response, 200, {
      ok: true,
      frontend: runtime.frontendBaseUrl,
      backend: runtime.backendBaseUrl,
      viewerDist,
    });
    return;
  }

  if (pathname === "/_radsysx/desktop/shutdown") {
    if (process.env.RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN !== "1") {
      writeJson(response, 404, { ok: false });
      return;
    }
    writeJson(response, 200, { ok: true });
    shuttingDown = true;
    setTimeout(() => app.quit(), 25).unref();
    return;
  }

  if (pathname === "/viewer" || pathname.startsWith("/viewer/")) {
    serveViewer(requestUrl, response);
    return;
  }

  if (pathname === "/dicom-web" || pathname.startsWith("/dicom-web/")) {
    const target = process.env.RADSYSX_DESKTOP_DICOMWEB_TARGET;
    proxyRequest(request, response, target || runtime.backendBaseUrl, target ? "/dicom-web" : "");
    return;
  }

  if (isBackendRoute(pathname)) {
    proxyRequest(request, response, runtime.backendBaseUrl);
    return;
  }

  proxyRequest(request, response, runtime.frontendBaseUrl);
}

function isBackendRoute(pathname) {
  return [
    "/api",
    "/process",
    "/stream",
    "/chat",
    "/tools",
    "/execute_tool",
    "/fhir",
    "/mcp",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/static",
  ].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function proxyRequest(request, response, targetBaseUrl, stripPrefix = "") {
  const targetUrl = buildProxyUrl(targetBaseUrl, request.url ?? "/", stripPrefix);
  const headers = sanitizeProxyHeaders(request.headers, targetUrl.host);

  const transport = targetUrl.protocol === "https:" ? https : http;
  const proxy = transport.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      method: request.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
      agent: false,
      insecureHTTPParser: isLoopbackHost(targetUrl.hostname),
    },
    (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
      proxyResponse.pipe(response);
    },
  );

  proxy.once("error", (error) => {
    if (
      smokeExitScheduled &&
      isLoopbackHost(targetUrl.hostname) &&
      (request.method === "GET" || request.method === "HEAD") &&
      error.message.startsWith("Parse Error")
    ) {
      return;
    }

    appendLog("bridge", `proxy error for ${targetUrl.href}: ${error.message}`);
    if (!response.headersSent) {
      writeText(
        response,
        502,
        "RadSysX local bridge could not reach an internal service.\n\n" +
          `${error.message}\n\n` +
          recentLogs(),
      );
    } else {
      response.end();
    }
  });

  if (request.method === "GET" || request.method === "HEAD") {
    proxy.end();
    return;
  }

  request.pipe(proxy);
}

function writeRawHeaders(socket, headers) {
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        socket.write(`${name}: ${item}\r\n`);
      }
    } else if (value != null) {
      socket.write(`${name}: ${value}\r\n`);
    }
  }
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function handleBridgeUpgrade(request, socket, head, runtime) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const targetBaseUrl = isBackendRoute(requestUrl.pathname)
    ? runtime.backendBaseUrl
    : runtime.frontendBaseUrl;
  const targetUrl = buildProxyUrl(targetBaseUrl, request.url ?? "/", "");

  if (targetUrl.protocol !== "http:") {
    socket.destroy();
    return;
  }

  const headers = sanitizeProxyHeaders(request.headers, targetUrl.host);
  headers.connection = "Upgrade";
  headers.upgrade = request.headers.upgrade ?? "websocket";

  const upstream = net.connect(
    Number.parseInt(targetUrl.port || "80", 10),
    targetUrl.hostname,
    () => {
      upstream.write(`${request.method} ${targetUrl.pathname}${targetUrl.search} HTTP/${request.httpVersion}\r\n`);
      writeRawHeaders(upstream, headers);
      upstream.write("\r\n");
      if (head.length) {
        upstream.write(head);
      }
      upstream.pipe(socket);
      socket.pipe(upstream);
    },
  );

  upstream.once("error", (error) => {
    if (shuttingDown || socket.destroyed) {
      return;
    }
    appendLog("bridge", `upgrade proxy error for ${targetUrl.href}: ${error.message}`);
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
  });
  socket.once("error", () => upstream.destroy());
  socket.once("close", () => upstream.destroy());
}

function sanitizeProxyHeaders(sourceHeaders, host) {
  const headers = { ...sourceHeaders };
  for (const header of [
    "accept-encoding",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete headers[header];
  }
  headers.host = host;
  headers.connection = "close";
  return headers;
}

function buildProxyUrl(targetBaseUrl, originalUrl, stripPrefix) {
  const target = new URL(targetBaseUrl);
  const source = new URL(originalUrl, "http://127.0.0.1");
  let sourcePathname = source.pathname;

  if (stripPrefix && sourcePathname.startsWith(stripPrefix)) {
    sourcePathname = sourcePathname.slice(stripPrefix.length) || "/";
  }

  const basePath = target.pathname.replace(/\/$/, "");
  const pathSuffix = sourcePathname.startsWith("/") ? sourcePathname : `/${sourcePathname}`;
  target.pathname = `${basePath}${pathSuffix}`.replace(/\/{2,}/g, "/");
  target.search = source.search;
  return target;
}

function serveViewer(requestUrl, response) {
  if (requestUrl.pathname === "/viewer") {
    response.writeHead(302, { location: "/viewer/" });
    response.end();
    return;
  }

  let relativePath = "";
  try {
    relativePath = decodeURIComponent(requestUrl.pathname.replace(/^\/viewer\/?/, ""));
  } catch {
    writeText(response, 400, "Viewer asset path is invalid.");
    return;
  }

  const normalized = path.normalize(relativePath || "index.html").replace(/^(\.\.(\/|\\|$))+/, "");
  const candidatePath = safeJoin(viewerDist, normalized);
  const resolvedPath = candidatePath ?? path.join(viewerDist, "index.html");
  const hasExtension = path.extname(resolvedPath) !== "";
  const filePath = fileExists(resolvedPath)
    ? resolvedPath
    : hasExtension
      ? null
      : path.join(viewerDist, "index.html");

  if (!filePath || !fileExists(filePath)) {
    writeText(response, 404, "Viewer asset was not found.");
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": viewerCacheControl(filePath),
  });
  fs.createReadStream(filePath).pipe(response);
}

function viewerCacheControl(filePath) {
  const assetName = path.basename(filePath);
  if (filePath.endsWith("index.html") || assetName === "app-config.js" || viewerAssetNames.includes(assetName)) {
    return "no-store";
  }
  return "public, max-age=300";
}

function safeJoin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return resolvedPath;
  }
  return null;
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return types[extension] ?? "application/octet-stream";
}

function writeJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function writeText(response, status, text) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

function createMainWindow() {
  const window = new BrowserWindow({
    title: "RadSysX",
    width: 1440,
    height: 980,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: "#020617",
    icon: fs.existsSync(logoPath) ? logoPath : undefined,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: false,
    },
  });

  window.setTitle("RadSysX");
  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle("RadSysX");
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (publicBaseUrl && url.startsWith(publicBaseUrl)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

function registerDesktopIpc() {
  ipcMain.handle("radsysx:select-local-imaging", async (event, options = {}) => {
    const mode = options?.mode === "folder" ? "folder" : "files";
    const selection = await selectLocalImagingPaths(event.sender, mode);
    if (selection.cancelled) {
      return { cancelled: true, files: [] };
    }

    const files = await collectPickedFiles(selection.filePaths);
    return { cancelled: false, files };
  });

  ipcMain.handle("radsysx:import-local-imaging", async (event, options = {}) => {
    const mode = options?.mode === "folder" ? "folder" : "files";
    const selection = await selectLocalImagingPaths(event.sender, mode);
    if (selection.cancelled) {
      return { cancelled: true, response: null };
    }

    const response = await importPickedFilesThroughBackend(event.sender, selection.filePaths);
    return { cancelled: false, response };
  });
}

async function selectLocalImagingPaths(sender, mode) {
  const testPaths = readPickerTestPaths();
  if (testPaths) {
    return { cancelled: false, filePaths: testPaths };
  }

  const parentWindow = BrowserWindow.fromWebContents(sender) ?? mainWindow;
  const dialogOptions = {
    title: mode === "folder" ? "Import local imaging folder" : "Import local imaging files",
    properties:
      mode === "folder"
        ? ["openDirectory", "multiSelections"]
        : ["openFile", "multiSelections"],
    filters: [
      {
        name: "Medical imaging files",
        extensions: [
          "bmp",
          "dcm",
          "dicom",
          "gif",
          "hdr",
          "img",
          "jpg",
          "jpeg",
          "nii",
          "gz",
          "png",
          "tif",
          "tiff",
          "zip",
        ],
      },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return { cancelled: true, filePaths: [] };
  }

  return { cancelled: false, filePaths: result.filePaths };
}

function loadingHtml() {
  return htmlDocument({
    title: "Starting RadSysX",
    heading: "Starting RadSysX",
    body: "",
    details: "",
    loading: true,
  });
}

function failureHtml(title, details) {
  return htmlDocument({
    title,
    heading: title,
    body:
      "The desktop fast path could not finish startup. Run `npm run desktop:doctor` from the repo root for the shortest repair path.",
    details,
  });
}

function htmlDocument({ title, heading, body, details, loading = false }) {
  const escapedDetails = escapeHtml(details);
  const logoMarkup = startupLogoMarkup();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          linear-gradient(135deg, rgba(12, 18, 28, 0.92), rgba(5, 8, 13, 0.98)),
          #05080d;
        color: #e2e8f0;
      }
      main {
        width: min(440px, calc(100vw - 48px));
        display: grid;
        justify-items: center;
        gap: 24px;
        text-align: center;
      }
      .brand-logo {
        display: block;
        width: min(280px, 72vw);
        height: auto;
        filter: drop-shadow(0 18px 38px rgba(0, 0, 0, 0.42));
      }
      .brand-fallback {
        border: 1px solid rgba(103, 232, 249, 0.28);
        border-radius: 8px;
        padding: 14px 20px;
        color: #ecfeff;
        font-size: 24px;
        font-weight: 800;
        letter-spacing: 0.04em;
      }
      h1 {
        margin: 0;
        font-size: clamp(24px, 4vw, 34px);
        font-weight: 700;
        letter-spacing: 0;
      }
      p {
        margin: 0;
        line-height: 1.6;
        color: #cbd5e1;
      }
      .progress {
        position: relative;
        width: min(320px, 72vw);
        height: 6px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.2);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05);
      }
      .progress::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 42%;
        border-radius: inherit;
        background: linear-gradient(90deg, #67e8f9, #f87171, #67e8f9);
        animation: radsysx-progress 1.35s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      }
      pre {
        margin: 0;
        width: 100%;
        text-align: left;
        max-height: 360px;
        overflow: auto;
        white-space: pre-wrap;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: #020617;
        padding: 16px;
        color: #bae6fd;
      }
      @keyframes radsysx-progress {
        0% {
          transform: translateX(-120%);
        }
        100% {
          transform: translateX(260%);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .progress::before {
          animation: none;
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <main role="${loading ? "status" : "main"}" aria-live="${loading ? "polite" : "off"}">
      ${logoMarkup}
      <h1>${escapeHtml(heading)}</h1>
      ${body ? `<p>${escapeHtml(body)}</p>` : ""}
      ${loading ? '<div class="progress" aria-label="RadSysX startup progress"></div>' : ""}
      ${details ? `<pre>${escapedDetails}</pre>` : ""}
    </main>
  </body>
</html>`;
}

function startupLogoMarkup() {
  const preferredLogoPath = fs.existsSync(logoLightPath) ? logoLightPath : logoPath;
  if (!fs.existsSync(preferredLogoPath)) {
    return '<div class="brand-fallback">RadSysX</div>';
  }

  try {
    const logoData = fs.readFileSync(preferredLogoPath).toString("base64");
    return `<img class="brand-logo" src="data:image/png;base64,${logoData}" alt="RadSysX" />`;
  } catch {
    return '<div class="brand-fallback">RadSysX</div>';
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showRuntimeFailure(title, details) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(failureHtml(title, details))}`);
}

function scheduleSmokeExit() {
  const exitAfterReadyMs = Number.parseInt(process.env.RADSYSX_DESKTOP_EXIT_AFTER_READY_MS ?? "", 10);
  if (!Number.isFinite(exitAfterReadyMs) || exitAfterReadyMs <= 0) {
    return;
  }

  appendLog("desktop", `smoke exit scheduled in ${exitAfterReadyMs}ms`);
  smokeExitScheduled = true;
  setTimeout(() => app.quit(), exitAfterReadyMs).unref();
}

async function shutdown() {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  shuttingDown = true;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }

  for (const child of children) {
    stopChild(child);
  }
  children.clear();

  if (bridgeServer) {
    bridgeServer.closeAllConnections?.();
    await new Promise((resolve) => bridgeServer.close(resolve));
    bridgeServer = null;
  }
}

app.setName("RadSysX");
registerDesktopIpc();

app.whenReady().then(async () => {
  mainWindow = createMainWindow();
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`);

  try {
    const runtime = await startRuntime();
    scheduleSmokeExit();
    await mainWindow.loadURL(desktopStartUrl(runtime.publicBaseUrl) ?? runtime.publicBaseUrl);
  } catch (error) {
    if (shuttingDown) {
      return;
    }
    appendLog("desktop", error instanceof Error ? error.stack ?? error.message : String(error));
    showRuntimeFailure("RadSysX startup failed", recentLogs());
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      mainWindow.loadURL(
        desktopStartUrl() ?? `data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`,
      );
    }
  });
});

app.on("before-quit", (event) => {
  if (shutdownStarted || (children.size === 0 && !bridgeServer)) {
    return;
  }

  event.preventDefault();
  shutdown()
    .catch((error) => appendLog("desktop", error instanceof Error ? error.message : String(error)))
    .finally(() => app.quit());
});

app.on("window-all-closed", async () => {
  await shutdown();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

process.on("SIGINT", async () => {
  await shutdown();
  app.quit();
});

process.on("SIGTERM", async () => {
  await shutdown();
  app.quit();
});
