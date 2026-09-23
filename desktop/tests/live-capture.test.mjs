import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { ViewerCapture, assertDesktopSender, isViewerUrl, mayUseMicrophone, mayUseViewerPermission, readViewportRectangle, validatedRectangle } from "../src/live-capture.mjs";
import { publicChildEnvironment, serviceEnvironment } from "../src/environment.mjs";
import { expectedAiVersions, dependencyMismatches } from "../scripts/ai-dependencies.mjs";
import path from "node:path";

const origin = "http://127.0.0.1:3000";
function fixture(overrides = {}) {
  let clock = 1000;
  let calls = 0;
  const rect = { x: 10, y: 20, width: 1200, height: 800 };
  const session = { contextVersion: 1, attestation: "synthetic", status: "ready", viewerContext: { targetId: "target-1", captureTarget: "viewer" } };
  const image = (width = 1200, height = 800) => ({
    isEmpty: () => false, getSize: () => ({ width, height }), resize: options => image(options.width, options.height), toJPEG: () => Buffer.from("synthetic-jpeg"),
  });
  const contents = {
    id: 1, mainFrame: { url: `${origin}/viewer/dicomlocal` }, isDestroyed: () => false,
    getURL: () => contents.mainFrame.url, getZoomFactor: () => 1,
    capturePage: async received => { assert.deepEqual(received, rect); calls++; return image(); },
  };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const input = { sessionId: "session-1", targetId: "target-1", viewportId: "viewport-1", contextVersion: 1, rect };
  const capture = new ViewerCapture({ getContents: () => contents, getOrigin: () => origin,
    getSession: async () => session, getRectangle: async () => ({ rect, bounds: { width: 1440, height: 980 } }), now: () => clock, ...overrides });
  return { capture, contents, event, input, session, rect, calls: () => calls, tick: value => { clock += value; } };
}

test("capture is an explicit attested lease, bounded thumbnail, and one fps", async () => {
  const f = fixture();
  await assert.rejects(f.capture.frame(f.event, f.input), /Start sharing again/);
  const lease = await f.capture.start(f.event, f.input);
  const request = { ...f.input, leaseId: lease.leaseId };
  const frame = await f.capture.frame(f.event, request);
  assert.equal(frame.mimeType, "image/jpeg");
  assert.equal(frame.width, 768);
  assert.equal(frame.height, 512);
  assert.equal(frame.contextVersion, 1);
  await assert.rejects(f.capture.frame(f.event, request), /one frame per second/);
  f.tick(1000);
  await f.capture.frame(f.event, request);
  assert.equal(f.calls(), 2);
  f.capture.stop(f.event, lease);
  f.tick(1000);
  await assert.rejects(f.capture.frame(f.event, request), /Start sharing again/);
  assert.equal(f.calls(), 2);
});

test("main-frame and exact-origin checks reject spoofed origins and subframes", () => {
  const f = fixture();
  for (const url of ["http://127.0.0.1:30000/viewer/", "http://127.0.0.1:3000.evil.example/viewer/", `${origin}/worklist`, `${origin}/viewer/fhir-viewer`, "data:text/html,viewer", "https://example.com/viewer/"]) {
    assert.equal(isViewerUrl(url, origin), false);
    f.contents.mainFrame.url = url;
    assert.throws(() => assertDesktopSender(f.event, f.contents, origin));
  }
  f.contents.mainFrame.url = `${origin}/viewer/local`;
  assert.throws(() => assertDesktopSender({ ...f.event, senderFrame: { url: f.contents.mainFrame.url } }, f.contents, origin), /main frame/);
  assert.throws(() => assertDesktopSender({ ...f.event, sender: { ...f.contents } }, f.contents, origin), /main frame/);
});

test("microphone permits only audio from the same viewer main frame", () => {
  const f = fixture();
  const details = { isMainFrame: true, requestingUrl: f.contents.getURL(), mediaTypes: ["audio"] };
  assert.equal(mayUseMicrophone(f.contents, f.contents, origin, "media", details), true);
  assert.equal(mayUseMicrophone(f.contents, f.contents, origin, "media", { ...details, mediaTypes: ["audio", "video"] }), false);
  assert.equal(mayUseMicrophone(f.contents, f.contents, origin, "media", { ...details, isMainFrame: false }), false);
  assert.equal(mayUseMicrophone(f.contents, f.contents, origin, "display-capture", details), false);
  assert.equal(mayUseMicrophone(f.contents, f.contents, origin, "media", { ...details, requestingUrl: `${origin}/viewer/fhir-viewer` }), false);
  assert.equal(mayUseMicrophone(null, f.contents, origin, "media", details), false);
  assert.equal(mayUseMicrophone(f.contents, f.contents, origin, "media", { isMainFrame: true, requestingUrl: f.contents.getURL(), mediaType: "audio" }, origin), true);
  assert.equal(mayUseMicrophone(f.contents, f.contents, origin, "media", { isMainFrame: true, requestingUrl: f.contents.getURL(), mediaType: "audio" }, "https://example.com"), false);
});

test("viewer permission policy preserves fullscreen and pointer tools only in its main frame", () => {
  const f = fixture();
  const details = { isMainFrame: true, requestingUrl: f.contents.getURL() };
  for (const permission of ["fullscreen", "pointerLock"]) {
    assert.equal(mayUseViewerPermission(f.contents, f.contents, origin, permission, details, origin), true);
    assert.equal(mayUseViewerPermission(f.contents, f.contents, origin, permission, { ...details, isMainFrame: false }), false);
    assert.equal(mayUseViewerPermission(f.contents, f.contents, origin, permission, details, "https://example.com"), false);
    assert.equal(mayUseViewerPermission(null, null, origin, permission, details), false);
  }
  for (const permission of ["display-capture", "notifications", "geolocation", "clipboard-read"]) {
    assert.equal(mayUseViewerPermission(f.contents, f.contents, origin, permission, details), false);
  }
});

test("closed, unauthenticated, stale, and unattested sessions cannot capture", async () => {
  for (const update of [{ attestation: null }, { status: "closed" }, { status: "allocated" }, { contextVersion: 2 }, { viewerContext: { targetId: "other", captureTarget: "viewer" } }]) {
    const f = fixture();
    Object.assign(f.session, update);
    await assert.rejects(f.capture.start(f.event, f.input), /ready, attested/);
    assert.equal(f.calls(), 0);
  }
  const f = fixture({ getSession: async () => null });
  await assert.rejects(f.capture.start(f.event, f.input), /ready, attested/);
});

test("context switch or logout after lease revokes before capture", async () => {
  const f = fixture();
  const lease = await f.capture.start(f.event, f.input);
  f.session.contextVersion = 2;
  await assert.rejects(f.capture.frame(f.event, { ...f.input, leaseId: lease.leaseId }), /ready, attested/);
  assert.equal(f.calls(), 0);
  assert.equal(f.capture.leases.size, 0);
});

test("stop during an in-flight capture discards the image", async () => {
  const f = fixture();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.contents.capturePage = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const lease = await f.capture.start(f.event, f.input);
  const pending = f.capture.frame(f.event, { ...f.input, leaseId: lease.leaseId });
  await started;
  f.capture.stop(f.event, lease);
  release({ isEmpty: () => false });
  await assert.rejects(pending, /stopped/);
});

test("a concurrent frame cannot bypass the one-fps budget", async () => {
  const f = fixture();
  let release;
  f.contents.capturePage = () => new Promise(resolve => { release = resolve; });
  const lease = await f.capture.start(f.event, f.input);
  const input = { ...f.input, leaseId: lease.leaseId };
  const first = f.capture.frame(f.event, input);
  await new Promise(resolve => setImmediate(resolve));
  f.tick(2000);
  await assert.rejects(f.capture.frame(f.event, input), /one frame per second/);
  f.capture.stop(f.event, lease);
  release({});
  await assert.rejects(first, /stopped/);
});

test("expired leases require explicit restart", async () => {
  const f = fixture();
  const lease = await f.capture.start(f.event, f.input);
  f.tick(15000);
  await assert.rejects(f.capture.frame(f.event, { ...f.input, leaseId: lease.leaseId }), /Start sharing again/);
  assert.equal(f.calls(), 0);
});

test("navigation during capture prevents releasing pixels", async () => {
  const f = fixture();
  f.contents.capturePage = async () => {
    f.contents.mainFrame.url = "https://example.com";
    return { isEmpty: () => false };
  };
  const lease = await f.capture.start(f.event, f.input);
  await assert.rejects(f.capture.frame(f.event, { ...f.input, leaseId: lease.leaseId }), /active RadSysX viewer/);
  assert.equal(f.capture.leases.size, 0);
});

test("lease cannot switch viewport or target without new explicit start", async () => {
  const f = fixture();
  const lease = await f.capture.start(f.event, f.input);
  await assert.rejects(f.capture.frame(f.event, { ...f.input, viewportId: "different-viewport", leaseId: lease.leaseId }), /Start sharing again/);
  assert.equal(f.calls(), 0);
});

test("only the selected visible viewport rectangle is captured", () => {
  const f = fixture();
  assert.throws(() => validatedRectangle({ x: 0, y: 0, width: 1440, height: 980 }, f.rect, { width: 1440, height: 980 }), /visible imaging viewport/);
  assert.throws(() => validatedRectangle(f.rect, null, { width: 1440, height: 980 }), /visible imaging viewport/);
  assert.throws(() => validatedRectangle({ ...f.rect, x: NaN }, f.rect, { width: 1440, height: 980 }));
  const rect = { x: -10, y: 5, width: 100, height: 100 };
  assert.deepEqual(validatedRectangle(rect, rect, { width: 80, height: 90 }), { x: 0, y: 5, width: 80, height: 85 });
});

test("invalid context identifiers are rejected before backend access", async () => {
  const f = fixture({ getSession: async () => { throw new Error("backend must not be called"); } });
  for (const update of [{ sessionId: undefined }, { viewportId: "../other" }, { targetId: "" }, { contextVersion: -1 }]) {
    await assert.rejects(f.capture.start(f.event, { ...f.input, ...update }), /current AI session/);
  }
});

test("main-process rectangle probe rejects an inactive OHIF viewport", async () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  let active = "selected";
  const element = { getAttribute: () => "selected", querySelector: () => ({}), getBoundingClientRect: () => rect };
  const contents = { executeJavaScript: source => Promise.resolve(runInNewContext(source, {
    window: { __RADSYSX_OHIF_MANAGERS__: { servicesManager: { services: { viewportGridService: { getActiveViewportId: () => active } } } } },
    document: { querySelectorAll: () => [element] }, getComputedStyle: () => ({ visibility: "visible", display: "block" }), innerWidth: 100, innerHeight: 100,
  })) };
  assert.equal((await readViewportRectangle(contents, "selected")).rect.width, 100);
  active = "another-viewport";
  assert.equal(await readViewportRectangle(contents, "selected"), null);
});

test("only backend child receives provider and clinical secrets", () => {
  const env = { PATH: "/bin", RADSYSX_TYPESAFE_AI_API_KEY: "synthetic-typesafe", RADSYSX_NVIDIA_API_KEY: "synthetic-nvidia", GEMINI_API_KEY: "synthetic-key", GOOGLE_API_KEY: "synthetic-key", RADSYSX_GEMINI_API_KEY: "synthetic-key", RADSYSX_SESSION_SECRET: "synthetic-secret", NEXT_PUBLIC_API_TOKEN: "synthetic-token", GOOGLE_APPLICATION_CREDENTIALS: "/synthetic/path", RADSYSX_AI_ENABLED: "1", NEXT_PUBLIC_VIEWER_BASE_URL: "/viewer", DATABASE_URL: "postgres://synthetic@host/db", ARCHIVE_URL: "https://synthetic:secret@example.test" };
  const publicEnv = { PATH: "/bin", NEXT_PUBLIC_VIEWER_BASE_URL: "/viewer" };
  assert.deepEqual(publicChildEnvironment(env), publicEnv);
  for (const role of ["viewer", "frontend", "frontend-build", "npm"]) assert.deepEqual(serviceEnvironment(role, env), publicEnv);
  assert.deepEqual(serviceEnvironment("backend", env), env);
  assert.equal(serviceEnvironment("frontend", {}, { GEMINI_API_KEY: "override" }).GEMINI_API_KEY, undefined);
});

test("bootstrap and doctor require every direct AI and shared HTTPX/Pydantic pin", () => {
  const expected = expectedAiVersions(path.resolve(import.meta.dirname, "../.."));
  assert.deepEqual(Object.keys(expected).sort(), ["google-genai", "deepagents", "langchain-nvidia-ai-endpoints", "langchain-google-genai", "langchain", "langchain-core", "langgraph", "pillow", "python-dotenv", "websockets", "httpx", "pydantic", "cryptography"].sort());
  assert.deepEqual(dependencyMismatches(expected, expected), []);
  for (const name of Object.keys(expected)) {
    for (const found of [null, "0.0.0-incompatible"]) {
      const mismatches = dependencyMismatches(expected, { ...expected, [name]: found });
      assert.equal(mismatches.length, 1);
      assert.ok(mismatches[0].startsWith(name + ": expected "));
    }
  }
});


test("OpenAI backend credentials never reach renderer or build children", () => {
  const env = { PATH: "/usr/bin", RADSYSX_OPENAI_API_KEY: "synthetic-openai-secret", RADSYSX_GEMINI_API_KEY: "synthetic-gemini-secret" };
  assert.equal(serviceEnvironment("backend", env).RADSYSX_OPENAI_API_KEY, "synthetic-openai-secret");
  for (const name of ["viewer", "frontend", "npm", "build"]) {
    assert.equal(serviceEnvironment(name, env).RADSYSX_OPENAI_API_KEY, undefined);
    assert.equal(serviceEnvironment(name, env).RADSYSX_GEMINI_API_KEY, undefined);
  }
});
