import { randomUUID } from "node:crypto";

const LEASE_MS = 15000;
const FRAME_INTERVAL_MS = 1000;
const MAX_IMAGE_EDGE = 768;
const TOKEN = /^[A-Za-z0-9._:-]{1,200}$/;

export function isViewerUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && /^\/viewer(?:\/|$)/.test(url.pathname) &&
      !/^\/viewer\/fhir-viewer(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

export function assertDesktopSender(event, expected, origin, viewerOnly = true) {
  if (!expected || expected.isDestroyed() || event.sender !== expected ||
      !event.senderFrame || event.senderFrame !== expected.mainFrame ||
      event.senderFrame.detached) throw new Error("Desktop request is not from the RadSysX main frame.");
  const frameUrl = event.senderFrame.url;
  let valid = false;
  try {
    valid = new URL(frameUrl).origin === origin && new URL(expected.getURL()).origin === origin;
  } catch { /* data pages and missing origins are never eligible. */ }
  if (!valid || (viewerOnly && (!isViewerUrl(frameUrl, origin) || !isViewerUrl(expected.getURL(), origin)))) {
    throw new Error("Desktop request is not from the active RadSysX viewer.");
  }
}

export function mayUseMicrophone(contents, expected, origin, permission, details = {}, requestingOrigin) {
  if (!contents || contents !== expected || contents.isDestroyed() || permission !== "media" ||
      details.isMainFrame !== true || !isViewerUrl(contents.getURL(), origin) ||
      !isViewerUrl(details.requestingUrl, origin)) return false;
  if (requestingOrigin) {
    try { if (new URL(requestingOrigin).origin !== origin) return false; } catch { return false; }
  }
  if (Array.isArray(details.mediaTypes)) return details.mediaTypes.length === 1 && details.mediaTypes[0] === "audio";
  return details.mediaType === "audio";
}

export function mayUseViewerPermission(contents, expected, origin, permission, details = {}, requestingOrigin) {
  if (permission === "media") return mayUseMicrophone(contents, expected, origin, permission, details, requestingOrigin);
  // Keep native viewer fullscreen/pointer tools working without granting other devices.
  if (requestingOrigin) {
    try { if (new URL(requestingOrigin).origin !== origin) return false; } catch { return false; }
  }
  return Boolean(["fullscreen", "pointerLock"].includes(permission) && contents === expected &&
    contents && !contents.isDestroyed() && details.isMainFrame === true &&
    isViewerUrl(contents.getURL(), origin) && isViewerUrl(details.requestingUrl, origin));
}

function binding(input) {
  if (!input || ["sessionId", "targetId", "viewportId"].some(key => typeof input[key] !== "string" || !TOKEN.test(input[key])) ||
      !Number.isSafeInteger(input.contextVersion) || input.contextVersion < 1) {
    throw new Error("A current AI session and selected viewport are required for sharing.");
  }
  return { sessionId: input.sessionId, targetId: input.targetId, viewportId: input.viewportId, contextVersion: input.contextVersion };
}

function equalBinding(left, right) {
  return ["sessionId", "targetId", "viewportId", "contextVersion"].every(key => left[key] === right[key]);
}

export function validatedRectangle(rect, actual, bounds) {
  if (!rect || !actual || !bounds || ["x", "y", "width", "height"].some(key =>
    !Number.isFinite(rect[key]) || !Number.isFinite(actual[key]) || Math.abs(rect[key] - actual[key]) > 2)) {
    throw new Error("Select a visible imaging viewport before sharing.");
  }
  // Clip to the visible viewport, retaining CSS-pixel coordinates for capturePage.
  const x = Math.max(0, Math.ceil(actual.x));
  const y = Math.max(0, Math.ceil(actual.y));
  const right = Math.min(Math.floor(actual.x + actual.width), Math.floor(bounds.width));
  const bottom = Math.min(Math.floor(actual.y + actual.height), Math.floor(bounds.height));
  if (actual.width < 1 || actual.height < 1 || right <= x || bottom <= y) throw new Error("The selected viewport is not visible.");
  return { x, y, width: right - x, height: bottom - y };
}

export async function readViewportRectangle(contents, viewportId) {
  // Fixed source with a JSON-encoded value, never renderer-supplied execution code.
  return contents.executeJavaScript(`(() => {
    const id = ${JSON.stringify(viewportId)};
    const grid = window.__RADSYSX_OHIF_MANAGERS__?.servicesManager?.services?.viewportGridService;
    if (grid?.getActiveViewportId?.() !== id) return null;
    const element = [...document.querySelectorAll('[data-viewportid]')].find(node => node.getAttribute('data-viewportid') === id);
    if (!element || !element.querySelector('canvas')) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || rect.width < 1 || rect.height < 1) return null;
    return {rect: {x:rect.x,y:rect.y,width:rect.width,height:rect.height}, bounds:{width:innerWidth,height:innerHeight}};
  })()`);
}

export class ViewerCapture {
  constructor({ getContents, getOrigin, getSession, getRectangle = readViewportRectangle, now = Date.now }) {
    Object.assign(this, { getContents, getOrigin, getSession, getRectangle, now });
    this.leases = new Map();
  }

  revoke(contents) {
    if (contents) this.leases.delete(contents.id);
    else this.leases.clear();
  }

  async validate(event, input) {
    assertDesktopSender(event, this.getContents(), this.getOrigin());
    const current = binding(input);
    const session = await this.getSession(event.sender, current.sessionId);
    const context = session?.viewerContext;
    if (!session || session.contextVersion !== current.contextVersion || context?.targetId !== current.targetId ||
        context?.captureTarget !== "viewer" || !["synthetic", "deidentified"].includes(session.attestation) ||
        session.status !== "ready") {
      this.revoke(event.sender);
      throw new Error("Screen sharing requires a ready, attested AI session for this viewer context.");
    }
    assertDesktopSender(event, this.getContents(), this.getOrigin());
    return current;
  }

  async start(event, input) {
    const current = await this.validate(event, input);
    const geometry = await this.getRectangle(event.sender, current.viewportId);
    validatedRectangle(input.rect, geometry?.rect, geometry?.bounds);
    assertDesktopSender(event, this.getContents(), this.getOrigin());
    const lease = { ...current, leaseId: randomUUID(), expiresAt: this.now() + LEASE_MS, lastFrameAt: -Infinity, pending: false };
    this.leases.set(event.sender.id, lease);
    return { leaseId: lease.leaseId, expiresAt: lease.expiresAt };
  }

  stop(event, input = {}) {
    assertDesktopSender(event, this.getContents(), this.getOrigin(), false);
    const lease = this.leases.get(event.sender.id);
    if (!input.leaseId || lease?.leaseId === input.leaseId) this.revoke(event.sender);
    return { stopped: true };
  }

  async frame(event, input) {
    assertDesktopSender(event, this.getContents(), this.getOrigin());
    const lease = this.leases.get(event.sender.id);
    if (!lease || input?.leaseId !== lease.leaseId || !equalBinding(lease, binding(input)) || this.now() >= lease.expiresAt) {
      this.revoke(event.sender);
      throw new Error("Screen sharing has stopped. Start sharing again.");
    }
    if (lease.pending || this.now() - lease.lastFrameAt < FRAME_INTERVAL_MS) throw new Error("Screen sharing is limited to one frame per second.");
    lease.pending = true;
    lease.lastFrameAt = this.now();
    try {
      await this.validate(event, input);
      const geometry = await this.getRectangle(event.sender, lease.viewportId);
      const rect = validatedRectangle(input.rect, geometry?.rect, geometry?.bounds);
      if (this.leases.get(event.sender.id) !== lease) throw new Error("Screen sharing has stopped.");
      const zoom = event.sender.getZoomFactor?.() ?? 1;
      const captureRect = Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value * zoom)]));
      let picture = await event.sender.capturePage(captureRect);
      // Stop, navigation, context changes, or logout during capture invalidate the result.
      await this.validate(event, input);
      const currentGeometry = await this.getRectangle(event.sender, lease.viewportId);
      validatedRectangle(input.rect, currentGeometry?.rect, currentGeometry?.bounds);
      if (this.leases.get(event.sender.id) !== lease || this.now() >= lease.expiresAt) throw new Error("Screen sharing has stopped.");
      if (picture.isEmpty()) throw new Error("The selected viewport did not produce an image.");
      const size = picture.getSize();
      const ratio = Math.min(1, MAX_IMAGE_EDGE / size.width, MAX_IMAGE_EDGE / size.height);
      if (ratio < 1) picture = picture.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)) });
      const resized = picture.getSize();
      lease.expiresAt = this.now() + LEASE_MS;
      return { data: picture.toJPEG(75).toString("base64"), mimeType: "image/jpeg", contextVersion: lease.contextVersion,
        targetId: lease.targetId, width: resized.width, height: resized.height };
    } catch (error) {
      this.revoke(event.sender);
      throw error;
    } finally { lease.pending = false; }
  }
}
