// Starts an isolated, synthetic Electron app and a backend-owned fake provider.
// Never connects to Google or captures another application/window.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicChildEnvironment } from "../src/environment.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(desktopRoot, "..");
const providerId = process.argv.includes("--openai") ? "openai" : "gemini";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "radsysx-live-smoke-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let baseUrl;
let cdp;

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  send(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}

async function run() {
  if (!fs.existsSync(path.join(root, "backend/clinical/ai_fixture_server.py"))) {
    throw new Error("The backend synthetic Live fixture is missing.");
  }
  const ports = new Set();
  while (ports.size < 4) ports.add(await availablePort());
  const [appPort, backendPort, frontendPort, debugPort] = ports;
  const binary = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const env = {
    ...publicChildEnvironment(process.env),
    RADSYSX_APP_MODE: "pilot",
    RADSYSX_DESKTOP_PORT: String(appPort), RADSYSX_DESKTOP_BACKEND_PORT: String(backendPort),
    RADSYSX_DESKTOP_FRONTEND_PORT: String(frontendPort), RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN: "1",
    RADSYSX_DESKTOP_BACKEND_APP: "backend.clinical.ai_fixture_server:app",
    RADSYSX_CLINICAL_DATABASE_URL: `sqlite:///${path.join(temporary, "clinical.db").replaceAll("\\", "/")}`,
    RADSYSX_LOCAL_IMAGING_STORAGE_DIR: path.join(temporary, "imaging"),
    RADSYSX_SESSION_COOKIE_SECURE: "false", RADSYSX_GEMINI_API_KEY: "synthetic-unused-key",
    RADSYSX_OPENAI_API_KEY: "synthetic-unused-key",
    RADSYSX_AI_ENABLED: "true", RADSYSX_DESKTOP_START_PATH: "/viewer/local",
  };
  const logs = [];
  child = spawn(binary, ["--no-sandbox", `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(temporary, "profile")}`, "--use-fake-device-for-media-stream", desktopRoot],
  { cwd: root, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", error => logs.push(error.message));
  const output = chunk => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      logs.push(line);
      if (logs.length > 60) logs.shift();
      const ready = line.match(/RadSysX desktop is ready at (http:\/\/127\.0\.0\.1:\d+)/);
      if (ready) baseUrl = ready[1];
    }
  };
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  const deadline = Date.now() + 180000;
  while (!baseUrl && Date.now() < deadline && child.exitCode === null) await delay(200);
  if (!baseUrl) throw new Error(`Synthetic desktop did not start.\n${logs.join("\n")}`);
  let target;
  while (!target && Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      target = targets.find(value => value.type === "page" && value.url.startsWith(baseUrl));
    } catch { /* Startup may still be navigating. */ }
    if (!target) await delay(200);
  }
  if (!target) throw new Error("Synthetic Electron page did not load.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  cdp = new Cdp(socket);
  await delay(1000);
  const result = await cdp.evaluate(`(${syntheticScenario.toString()})(${JSON.stringify(providerId)})`);
  console.log(JSON.stringify({ ok: true, provider: "synthetic fixture (no cloud call)", ...result }, null, 2));
}

async function syntheticScenario(providerId) {
  const assert = (value, reason) => { if (!value) throw new Error(reason); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const request = async (route, body) => {
    const response = await fetch(route, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    assert(response.ok, `Synthetic API request failed (${response.status})`);
    return response.json();
  };
  assert(window.radsysxDesktop?.startViewerCapture, "Live capture preload is unavailable");
  // Chromium fake-device flags are supplied by this isolated smoke process.
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const microphoneTracks = microphone.getAudioTracks().length;
  microphone.getTracks().forEach(track => track.stop());
  assert(microphoneTracks === 1, "Synthetic microphone permission failed");
  let cameraDenied = false;
  try {
    const video = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    video.getTracks().forEach(track => track.stop());
  } catch { cameraDenied = true; }
  assert(cameraDenied, "Camera permission should be denied");
  await request("/api/auth/local-login", { username: "demo-radiologist" });
  // Replace this test window with visibly synthetic content before capture.
  document.body.innerHTML = '<main style="margin:0"><div data-viewportid="synthetic-viewport" style="width:900px;height:600px"><canvas width="900" height="600"></canvas></div></main>';
  window.__RADSYSX_OHIF_MANAGERS__ = { servicesManager: { services: { viewportGridService: { getActiveViewportId: () => "synthetic-viewport" } } } };
  const canvas = document.querySelector("canvas");
  const context = canvas.getContext("2d");
  context.fillStyle = "#193349"; context.fillRect(0, 0, 900, 600);
  context.fillStyle = "#a7f3d0"; context.font = "42px sans-serif"; context.fillText("SYNTHETIC LIVE SMOKE", 45, 280);
  const session = await request("/api/ai/sidebar/sessions", { providerId, attestation: "synthetic", viewerContext: {
    targetId: "synthetic-target", captureTarget: "viewer", route: "/viewer/local", privacyClass: "local-only",
    state: { activeViewportId: "synthetic-viewport", viewports: [{ viewportId: "synthetic-viewport" }] },
  } });
  assert(session.providerId === providerId && session.inputSampleRate === (providerId === 'openai' ? 24000 : 16000), 'Session provider/audio profile mismatch');
  const route = session.liveUrl || `/api/ai/sidebar/sessions/${session.sessionId}/live`;
  const socket = new WebSocket(new URL(route, location.href).href.replace(/^http/, "ws"));
  socket.binaryType = "arraybuffer";
  const events = []; let audioBytes = 0; let actionCount = 0; let audioWhileResearch = 0; let peakResearchRunning = 0;
  const research = new Map();
  socket.onmessage = event => {
    if (event.data instanceof ArrayBuffer) {
      audioBytes += event.data.byteLength;
      if ([...research.values()].filter(status => status === "running").length === 2) audioWhileResearch += event.data.byteLength;
      return;
    }
    const message = JSON.parse(event.data); events.push(message);
    if (message.kind === "tool" && message.name === "research_run") {
      research.set(message.toolCallId, message.status);
      peakResearchRunning = Math.max(peakResearchRunning, [...research.values()].filter(status => status === "running").length);
    }
    if (message.kind === "viewer_action") {
      actionCount++;
      // Synthetic adapter changes this fixture only; the real OHIF adapter has separate tests.
      canvas.dataset.windowWidth = String(message.args?.windowWidth ?? 400);
      socket.send(JSON.stringify({ kind: "action_result", contextVersion: session.contextVersion, toolCallId: message.toolCallId,
        status: "completed", result: { windowWidth: Number(canvas.dataset.windowWidth) } }));
    }
  };
  const waitFor = async (predicate, reason) => {
    const until = Date.now() + 18000;
    while (!predicate() && Date.now() < until) await sleep(50);
    assert(predicate(), reason);
  };
  await waitFor(() => events.some(event => event.kind === "session" && event.status === "ready"), "Provider setup did not become ready through desktop WebSocket");
  const measured = document.querySelector("[data-viewportid]").getBoundingClientRect();
  const input = { sessionId: session.sessionId, contextVersion: session.contextVersion, targetId: "synthetic-target", viewportId: "synthetic-viewport",
    rect: { x: measured.x, y: measured.y, width: measured.width, height: measured.height } };
  const lease = await window.radsysxDesktop.startViewerCapture(input);
  socket.send(JSON.stringify({ kind: "screen_sharing", active: true, contextVersion: session.contextVersion }));
  const frame = await window.radsysxDesktop.captureViewerFrame({ ...input, leaseId: lease.leaseId });
  assert(frame.width <= 768 && frame.height <= 768 && frame.data.length > 100, "Capture thumbnail bounds or JPEG data invalid");
  socket.send(JSON.stringify({ kind: "screen", contextVersion: session.contextVersion, data: frame.data, mimeType: frame.mimeType }));
  socket.send(new Int16Array(640).buffer);
  socket.send(JSON.stringify({ kind: "audio_end", contextVersion: session.contextVersion }));
  socket.send(JSON.stringify({ kind: "text", contextVersion: session.contextVersion, text: "desktop smoke" }));
  socket.send(JSON.stringify({ kind: "ping", contextVersion: session.contextVersion }));
  await window.radsysxDesktop.stopViewerCapture({ leaseId: lease.leaseId });
  socket.send(JSON.stringify({ kind: "screen_sharing", active: false, contextVersion: session.contextVersion }));
  let stopped = false;
  try { await window.radsysxDesktop.captureViewerFrame({ ...input, leaseId: lease.leaseId }); } catch { stopped = true; }
  assert(stopped, "Capture continued after explicit stop");
  await waitFor(() => events.some(event => event.kind === "pong"), "WebSocket ping failed");
  assert(events.some(event => event.kind === "screen_status" && event.active && event.frameReceived), "Forwarded image had no backend receipt");
  await waitFor(() => events.some(event => event.kind === "screen_status" && !event.active && !event.frameReceived), "Stopped sharing was not acknowledged");
  await waitFor(() => actionCount > 0 && audioBytes > 0 && events.some(event => event.kind === "interaction" && event.status === "IDLE"), "Synthetic async action/audio/IDLE flow did not finish");
  assert(actionCount === 1, "Replayed tool call repeated the viewer action");
  assert(research.size === 2 && [...research.values()].every(status => status === "completed"), "Both delayed research tasks did not complete");
  assert(peakResearchRunning === 2 && audioWhileResearch > 0, "Audio did not continue while two research tasks ran concurrently");
  const citations = new Set(events.filter(event => event.kind === "citations").flatMap(event => event.sources.map(source => source.url)));
  assert(citations.size === 2, "Research citations were not returned");
  await request(`/api/ai/sidebar/sessions/${session.sessionId}/close`);
  socket.close();
  if (providerId === 'openai') assert(events.some(event => event.kind === 'audio_chunk'), 'OpenAI playback markers missing');
  return { providerId, capturedWidth: frame.width, capturedHeight: frame.height, stopped, microphoneTracks, cameraDenied, actionCount, audioBytes,
    researchCompleted: research.size, peakResearchRunning, audioWhileResearch, citations: citations.size,
    eventKinds: [...new Set(events.map(event => event.kind))] };
}

try { await run(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally {
  cdp?.socket.close();
  if (baseUrl) {
    try { await fetch(`${baseUrl}/_radsysx/desktop/shutdown`, { method: "POST" }); } catch { /* Runtime may have already exited. */ }
  }
  if (child?.exitCode === null) {
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
    if (child.exitCode === null) {
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill(); } catch { /* Already exited. */ }
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(1500)]);
    }
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
