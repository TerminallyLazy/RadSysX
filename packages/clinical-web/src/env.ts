export type AppMode = "research" | "pilot" | "clinical";

const DEFAULT_BACKEND_URL = "http://localhost:8000";

function normalizeMode(value: string | undefined): AppMode {
  switch ((value ?? "").trim().toLowerCase()) {
    case "pilot":
      return "pilot";
    case "clinical":
      return "clinical";
    default:
      return "research";
  }
}

function readProcessEnv(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) {
    return undefined;
  }
  return process.env[name];
}

function readPublicAppModeEnv(): string | undefined {
  if (typeof process === "undefined" || !process.env) {
    return undefined;
  }
  return process.env.NEXT_PUBLIC_RADSYSX_APP_MODE;
}

function readPublicBackendUrlEnv(): string | undefined {
  if (typeof process === "undefined" || !process.env) {
    return undefined;
  }
  return process.env.NEXT_PUBLIC_BACKEND_URL;
}

function readPublicViewerUrlEnv(): string | undefined {
  if (typeof process === "undefined" || !process.env) {
    return undefined;
  }
  return process.env.NEXT_PUBLIC_VIEWER_BASE_URL;
}

export function getAppMode(): AppMode {
  return normalizeMode(
    readProcessEnv("RADSYSX_APP_MODE") ?? readPublicAppModeEnv(),
  );
}

export function getPublicAppMode(): AppMode {
  return normalizeMode(readPublicAppModeEnv());
}

export function isResearchMode(): boolean {
  return getAppMode() === "research";
}

export function isExperimentalImagingEnabled(): boolean {
  return getAppMode() === "research";
}

export function getBackendBaseUrl(): string {
  const explicit = readPublicBackendUrlEnv() ?? readProcessEnv("NEXT_PUBLIC_BACKEND_URL");
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  if (typeof window !== "undefined") {
    return "";
  }

  return DEFAULT_BACKEND_URL;
}

export function getViewerBaseUrl(): string {
  const explicit = readPublicViewerUrlEnv() ?? readProcessEnv("NEXT_PUBLIC_VIEWER_BASE_URL");
  return (explicit ?? "/viewer").replace(/\/$/, "");
}
