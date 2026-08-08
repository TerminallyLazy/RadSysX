import { getBackendBaseUrl } from "./env";
import type {
  AIJobRecord,
  AIJobRequest,
  AISidebarCapabilities,
  AISidebarMessageRequest,
  AISidebarSessionCreateRequest,
  AISidebarSessionResponse,
  AISidebarTurnResponse,
  AuditStudyResponse,
  BiomedParseDemoCapabilities,
  BiomedParseDemoRunRequest,
  BiomedParseDemoRunResponse,
  ClinicalPlatformConfig,
  DerivedResultRequest,
  DerivedResultResponse,
  DerivedResultStowRequest,
  ImagingLaunchRequest,
  ImagingLaunchResolveResponse,
  ImagingLaunchResponse,
  LocalImagingImportResponse,
  LocalImagingStudyAnalysisResponse,
  LocalImagingStudyAssetsResponse,
  LocalLoginRequest,
  LocalLoginResponse,
  ReportDraftRequest,
  ReportRecord,
  SessionResponse,
  StudyWorkspace,
  WorklistResponse,
} from "./contracts";

type ClinicalApiOptions = {
  baseUrl?: string;
};

export function resolveClinicalApiUrl(path: string, options?: ClinicalApiOptions): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${options?.baseUrl ?? getBackendBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
  options?: ClinicalApiOptions,
): Promise<T> {
  const response = await fetch(resolveClinicalApiUrl(path, options), {
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

  return response.json() as Promise<T>;
}

async function requestMultipart<T>(
  path: string,
  form: FormData,
  options?: ClinicalApiOptions,
): Promise<T> {
  const response = await fetch(resolveClinicalApiUrl(path, options), {
    method: "POST",
    body: form,
    credentials: "include",
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(payload || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function createClinicalApi(options?: ClinicalApiOptions) {
  return {
    getSession(): Promise<SessionResponse> {
      return requestJson("/api/auth/session", undefined, options);
    },

    localLogin(payload: LocalLoginRequest): Promise<LocalLoginResponse> {
      return requestJson("/api/auth/local-login", {
        method: "POST",
        body: JSON.stringify(payload),
      }, options);
    },

    logout(): Promise<SessionResponse> {
      return requestJson("/api/auth/logout", { method: "POST" }, options);
    },

    getPlatformConfig(): Promise<ClinicalPlatformConfig> {
      return requestJson("/api/platform/config", undefined, options);
    },

    getWorklist(): Promise<WorklistResponse> {
      return requestJson("/api/worklist", undefined, options);
    },

    importLocalImaging(files: File[]): Promise<LocalImagingImportResponse> {
      const form = new FormData();
      const relativePaths: string[] = [];
      for (const file of files) {
        const relativePath = readBrowserRelativePath(file);
        relativePaths.push(relativePath);
        form.append("files", file, relativePath);
      }
      form.set("relativePaths", JSON.stringify(relativePaths));
      return requestMultipart("/api/local-imaging/import", form, options);
    },

    getLocalImagingStudyAssets(studyInstanceUID: string): Promise<LocalImagingStudyAssetsResponse> {
      return requestJson(
        `/api/local-imaging/studies/${encodeURIComponent(studyInstanceUID)}/assets`,
        undefined,
        options,
      );
    },

    getLocalImagingStudyAnalysis(studyInstanceUID: string): Promise<LocalImagingStudyAnalysisResponse> {
      return requestJson(
        `/api/local-imaging/studies/${encodeURIComponent(studyInstanceUID)}/analysis`,
        undefined,
        options,
      );
    },

    getBiomedParseDemoCapabilities(): Promise<BiomedParseDemoCapabilities> {
      return requestJson("/api/ai/biomedparse-demo/capabilities", undefined, options);
    },

    runBiomedParseDemo(payload: BiomedParseDemoRunRequest = {}): Promise<BiomedParseDemoRunResponse> {
      return requestJson("/api/ai/biomedparse-demo/run", {
        method: "POST",
        body: JSON.stringify(payload),
      }, options);
    },

    launchImaging(payload: ImagingLaunchRequest): Promise<ImagingLaunchResponse> {
      return requestJson("/api/imaging/launch", {
        method: "POST",
        body: JSON.stringify(payload),
      }, options);
    },

    resolveLaunch(launchToken: string): Promise<ImagingLaunchResolveResponse> {
      const params = new URLSearchParams({ launch: launchToken });
      return requestJson(`/api/imaging/launch/resolve?${params.toString()}`, undefined, options);
    },

    saveDraft(payload: ReportDraftRequest): Promise<ReportRecord> {
      return requestJson("/api/reports/draft", {
        method: "POST",
        body: JSON.stringify(payload),
      }, options);
    },

    createAIJob(payload: AIJobRequest): Promise<AIJobRecord> {
      return requestJson("/api/ai/jobs", {
        method: "POST",
        body: JSON.stringify(payload),
      }, options);
    },

    getAISidebarCapabilities(): Promise<AISidebarCapabilities> {
      return requestJson("/api/ai/sidebar/capabilities", undefined, options);
    },

    createAISidebarSession(payload: AISidebarSessionCreateRequest = {}): Promise<AISidebarSessionResponse> {
      return requestJson("/api/ai/sidebar/sessions", {
        method: "POST",
        body: JSON.stringify(payload),
      }, options);
    },

    submitAISidebarMessage(
      sessionId: string,
      payload: AISidebarMessageRequest,
    ): Promise<AISidebarTurnResponse> {
      return requestJson(`/api/ai/sidebar/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        body: JSON.stringify(payload),
      }, options);
    },

    storeDerivedResults(payload: DerivedResultRequest): Promise<DerivedResultResponse> {
      return requestJson("/api/derived-results", {
        method: "POST",
        body: JSON.stringify(payload),
      }, options);
    },

    storeDerivedResultsStow(
      payload: DerivedResultStowRequest,
      files: File[],
    ): Promise<DerivedResultResponse> {
      const form = new FormData();
      form.set("studyInstanceUID", payload.studyInstanceUID);
      form.set("objectType", payload.objectType);
      form.set("storageClass", payload.storageClass);
      if (payload.seriesInstanceUID) {
        form.set("seriesInstanceUID", payload.seriesInstanceUID);
      }
      if (payload.sopInstanceUID) {
        form.set("sopInstanceUID", payload.sopInstanceUID);
      }
      form.set("contentType", payload.contentType ?? "application/dicom");
      form.set("metadata", JSON.stringify(payload.metadata ?? {}));
      if (payload.traceId) {
        form.set("traceId", payload.traceId);
      }
      for (const file of files) {
        form.append("files", file, file.name);
      }
      return requestMultipart("/api/derived-results/stow", form, options);
    },

    getAuditForStudy(studyInstanceUID: string): Promise<AuditStudyResponse> {
      return requestJson(`/api/audit/studies/${encodeURIComponent(studyInstanceUID)}`, undefined, options);
    },

    getStudyWorkspace(studyInstanceUID: string): Promise<StudyWorkspace> {
      return requestJson(`/api/studies/${encodeURIComponent(studyInstanceUID)}/workspace`, undefined, options);
    },
  };
}

function readBrowserRelativePath(file: File): string {
  const maybeRelative = (
    file as File & {
      radsysxRelativePath?: string;
      webkitRelativePath?: string;
    }
  ).radsysxRelativePath ?? (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return maybeRelative && maybeRelative.trim() ? maybeRelative : file.name;
}

export const clinicalApi = createClinicalApi();
