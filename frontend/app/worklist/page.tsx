"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, FileSearch, FolderOpen, Loader2, ShieldCheck, Stethoscope, Upload, X } from "lucide-react";

import { clinicalApi, resolveClinicalApiUrl } from "@/lib/clinical/client";
import type {
  BiomedParseDemoCapabilities,
  BiomedParseDemoRunResponse,
  ClinicalPlatformConfig,
  LocalImagingImportResponse,
  LocalImagingStudyAsset,
  LocalImagingStudyAnalysisResponse,
  LocalImagingStudyAssetsResponse,
  SessionClaims,
  WorklistRow,
} from "@/lib/clinical/contracts";

const LOCAL_START_INSPECT_KEY = "radsysx.localStart.inspectStudyUid";

type DesktopPickedFile = {
  data: ArrayBuffer | ArrayBufferView;
  lastModified?: number;
  name: string;
  relativePath: string;
  size: number;
  type?: string;
};

type DesktopPickerMode = "files" | "folder";
type NiftiPreviewState = {
  axis: string;
  slice: number;
};
type BrowserFileSystemEntry = {
  fullPath?: string;
  isDirectory: boolean;
  isFile: boolean;
  name: string;
};
type BrowserFileSystemFileEntry = BrowserFileSystemEntry & {
  file: (
    successCallback: (file: File) => void,
    errorCallback?: (error: DOMException) => void,
  ) => void;
};
type BrowserFileSystemDirectoryEntry = BrowserFileSystemEntry & {
  createReader: () => {
    readEntries: (
      successCallback: (entries: BrowserFileSystemEntry[]) => void,
      errorCallback?: (error: DOMException) => void,
    ) => void;
  };
};
type BrowserDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => unknown;
};

declare global {
  interface Window {
    radsysxDesktop?: {
      selectLocalImagingFiles?: (options?: { mode?: DesktopPickerMode }) => Promise<{
        cancelled: boolean;
        files: DesktopPickedFile[];
      }>;
      importLocalImaging?: (options?: { mode?: DesktopPickerMode }) => Promise<{
        cancelled: boolean;
        response: LocalImagingImportResponse | null;
      }>;
      versions?: {
        chrome?: string;
        electron?: string;
        node?: string;
      };
    };
  }
}

export default function WorklistPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [config, setConfig] = useState<ClinicalPlatformConfig | null>(null);
  const [session, setSession] = useState<SessionClaims | null>(null);
  const [rows, setRows] = useState<WorklistRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [launchingStudyUid, setLaunchingStudyUid] = useState<string | null>(null);
  const [inspectingStudyUid, setInspectingStudyUid] = useState<string | null>(null);
  const [analyzingStudyUid, setAnalyzingStudyUid] = useState<string | null>(null);
  const [localStudyAssets, setLocalStudyAssets] = useState<LocalImagingStudyAssetsResponse | null>(null);
  const [localStudyAnalysis, setLocalStudyAnalysis] = useState<LocalImagingStudyAnalysisResponse | null>(null);
  const [biomedParseDemoCapabilities, setBiomedParseDemoCapabilities] = useState<BiomedParseDemoCapabilities | null>(null);
  const [biomedParseDemoResult, setBiomedParseDemoResult] = useState<BiomedParseDemoRunResponse | null>(null);
  const [biomedParseDemoError, setBiomedParseDemoError] = useState<string | null>(null);
  const [biomedParseDemoRunning, setBiomedParseDemoRunning] = useState(false);
  const [niftiPreviewStates, setNiftiPreviewStates] = useState<Record<string, NiftiPreviewState>>({});
  const [draggingLocalImport, setDraggingLocalImport] = useState(false);
  const consumedLocalStartInspectRef = useRef(false);

  const directoryInputProps = {
    directory: "",
    webkitdirectory: "",
  } as Record<string, string>;

  const loadClinicalWorkspace = useCallback(async (cancelled?: () => boolean) => {
    try {
      const sessionResponse = await clinicalApi.getSession();
      if (!sessionResponse.authenticated || !sessionResponse.session) {
        router.replace("/login?next=%2Fworklist");
        return;
      }

      const [platformConfig, worklist, biomedParseDemo] = await Promise.all([
        clinicalApi.getPlatformConfig(),
        clinicalApi.getWorklist(),
        clinicalApi.getBiomedParseDemoCapabilities().catch(() => null),
      ]);

      if (cancelled?.()) {
        return;
      }

      setSession(sessionResponse.session);
      setConfig(platformConfig);
      setRows(worklist.rows);
      setBiomedParseDemoCapabilities(biomedParseDemo);
    } catch (cause) {
      if (!cancelled?.()) {
        setError(cause instanceof Error ? cause.message : "Failed to load clinical worklist.");
      }
    }
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    void loadClinicalWorkspace(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadClinicalWorkspace]);

  const headline = useMemo(() => {
    if (!config) {
      return "Loading clinical platform posture...";
    }
    return `Clinical worklist in ${config.mode} mode`;
  }, [config]);

  const handleOpenViewer = async (row: WorklistRow) => {
    setLaunchingStudyUid(row.studyInstanceUID);
    try {
      const launch = await clinicalApi.launchImaging({
        studyInstanceUID: row.studyInstanceUID,
      });
      window.location.assign(launch.viewerUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to launch viewer.");
    } finally {
      setLaunchingStudyUid(null);
    }
  };

  const handleInspectLocalStudy = async (row: WorklistRow) => {
    setInspectingStudyUid(row.studyInstanceUID);
    setError(null);
    setLocalStudyAnalysis(null);
    setNiftiPreviewStates({});
    try {
      const assets = await clinicalApi.getLocalImagingStudyAssets(row.studyInstanceUID);
      setLocalStudyAssets(assets);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to inspect local imaging files.");
    } finally {
      setInspectingStudyUid(null);
    }
  };

  useEffect(() => {
    if (consumedLocalStartInspectRef.current || !config?.localImagingEnabled || rows.length === 0) {
      return;
    }

    let studyInstanceUID: string | null = null;
    try {
      studyInstanceUID = window.sessionStorage.getItem(LOCAL_START_INSPECT_KEY);
    } catch {
      studyInstanceUID = null;
    }
    if (!studyInstanceUID) {
      return;
    }

    const row = rows.find((candidate) => candidate.studyInstanceUID === studyInstanceUID);
    if (!row || !row.archiveRef.startsWith("local://")) {
      return;
    }

    consumedLocalStartInspectRef.current = true;
    try {
      window.sessionStorage.removeItem(LOCAL_START_INSPECT_KEY);
    } catch {
      // Ignore storage failures; inspection can still proceed.
    }
    void handleInspectLocalStudy(row);
  }, [config?.localImagingEnabled, rows]);

  const handleAnalyzeLocalStudy = async (studyInstanceUID: string) => {
    setAnalyzingStudyUid(studyInstanceUID);
    setError(null);
    try {
      const analysis = await clinicalApi.getLocalImagingStudyAnalysis(studyInstanceUID);
      setLocalStudyAnalysis(analysis);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to analyze local imaging files.");
    } finally {
      setAnalyzingStudyUid(null);
    }
  };

  const handleRunBiomedParseDemo = async () => {
    setBiomedParseDemoRunning(true);
    setBiomedParseDemoError(null);
    setBiomedParseDemoResult(null);
    try {
      setBiomedParseDemoResult(await clinicalApi.runBiomedParseDemo({
        source: "included_ct_amos",
        sliceBatchSize: 4,
      }));
    } catch (cause) {
      setBiomedParseDemoError(cause instanceof Error ? cause.message : "Unable to run BioMedParse demo.");
    } finally {
      setBiomedParseDemoRunning(false);
    }
  };

  const beginLocalImport = () => {
    setImporting(true);
    setError(null);
    setImportMessage(null);
    setImportWarnings([]);
    setLocalStudyAssets(null);
    setLocalStudyAnalysis(null);
    setNiftiPreviewStates({});
  };

  const clearLocalImportInputs = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (folderInputRef.current) {
      folderInputRef.current.value = "";
    }
  };

  const applyLocalImportResponse = async (response: LocalImagingImportResponse) => {
    const studyCount = response.importedStudies.length;
    setImportMessage(
      `Imported ${response.acceptedFiles} file${response.acceptedFiles === 1 ? "" : "s"} into ${studyCount} local stud${studyCount === 1 ? "y" : "ies"}.`,
    );
    setImportWarnings(response.warnings);
    const worklist = await clinicalApi.getWorklist();
    setRows(worklist.rows);
  };

  const importLocalFiles = async (files: File[]) => {
    if (!files.length) {
      return;
    }

    beginLocalImport();

    try {
      await applyLocalImportResponse(await clinicalApi.importLocalImaging(files));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to import local imaging files.");
    } finally {
      setImporting(false);
      clearLocalImportInputs();
    }
  };

  const handleLocalImport = async (fileList: FileList | null) => {
    await importLocalFiles(Array.from(fileList ?? []));
  };

  const handleLocalImportDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (config?.localImagingEnabled) {
      event.dataTransfer.dropEffect = "copy";
      setDraggingLocalImport(true);
    }
  };

  const handleLocalImportDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setDraggingLocalImport(false);
    }
  };

  const handleLocalImportDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDraggingLocalImport(false);

    if (!config?.localImagingEnabled || importing) {
      return;
    }

    try {
      await importLocalFiles(await filesFromDataTransfer(event.dataTransfer));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read dropped imaging files.");
    }
  };

  const handleDesktopLocalImport = async (mode: DesktopPickerMode) => {
    const desktopImport = window.radsysxDesktop?.importLocalImaging;
    if (desktopImport) {
      beginLocalImport();
      try {
        const result = await desktopImport({ mode });
        if (result.cancelled) {
          return;
        }
        if (!result.response) {
          throw new Error("Desktop local imaging import did not return a backend response.");
        }
        await applyLocalImportResponse(result.response);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to choose local imaging files.");
      } finally {
        setImporting(false);
        clearLocalImportInputs();
      }
      return;
    }

    const picker = window.radsysxDesktop?.selectLocalImagingFiles;
    if (!picker) {
      if (mode === "folder") {
        folderInputRef.current?.click();
      } else {
        fileInputRef.current?.click();
      }
      return;
    }

    setError(null);
    try {
      const result = await picker({ mode });
      if (result.cancelled) {
        return;
      }
      await importLocalFiles(result.files.map(desktopPickedFileToFile));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to choose local imaging files.");
    }
  };

  const updateNiftiPreviewState = (
    asset: LocalImagingStudyAsset,
    next: Partial<NiftiPreviewState>,
  ) => {
    setNiftiPreviewStates((currentStates) => {
      const current = getNiftiPreviewState(asset, currentStates[asset.assetId]);
      const axis = next.axis ?? current.axis;
      const sliceCount = Math.max(asset.previewSlices[axis] ?? 1, 1);
      const nextSlice = next.axis && next.axis !== current.axis && next.slice == null
        ? Math.floor(sliceCount / 2)
        : next.slice ?? current.slice;
      return {
        ...currentStates,
        [asset.assetId]: {
          axis,
          slice: clamp(nextSlice, 0, sliceCount - 1),
        },
      };
    });
  };

  const handleLogout = async () => {
    try {
      await clinicalApi.logout();
      router.replace("/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to end clinical session.");
    }
  };

  return (
    <div className="min-h-screen overflow-y-auto bg-[#0b1220] text-slate-100">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="rounded-3xl border border-cyan-400/30 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.16),_transparent_42%),linear-gradient(180deg,_rgba(15,23,42,0.96),_rgba(2,6,23,0.98))] p-8 shadow-2xl shadow-cyan-950/30">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.28em] text-cyan-300/80">
                <ShieldCheck className="h-4 w-4" />
                RadSysX Clinical Workspace
              </div>
              <h1 className="mt-3 text-3xl font-semibold text-white">{headline}</h1>
              <p className="mt-3 max-w-3xl text-sm text-slate-300">
                The worklist is now backed by the FastAPI clinical surface. Study launch is
                opaque and signed, triage remains shadow-first unless governance enables higher
                modes, and the legacy upload/analyze flows are treated as research-only.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {session && (
                <div className="text-right text-sm text-slate-300">
                  <div>{session.name}</div>
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">
                    {session.roles.join(", ")}
                  </div>
                </div>
              )}
              <Link
                href="/"
                className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm text-slate-200 transition hover:border-cyan-400/50 hover:text-white"
              >
                Research workstation
              </Link>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm text-cyan-100 transition hover:bg-cyan-300/20"
              >
                Sign out
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-6 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          {config?.localImagingEnabled && (
            <div
              data-testid="local-import-panel"
              onDragEnter={handleLocalImportDragEnter}
              onDragOver={handleLocalImportDragEnter}
              onDragLeave={handleLocalImportDragLeave}
              onDrop={(event) => void handleLocalImportDrop(event)}
              className={`mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-4 transition ${
                draggingLocalImport
                  ? "border-cyan-300/60 bg-cyan-300/10 shadow-lg shadow-cyan-950/30"
                  : "border-slate-800 bg-slate-950/70"
              }`}
            >
              <div>
                <div className="text-sm font-medium text-white">Local imaging import</div>
                <div className="mt-1 text-xs text-slate-400">
                  DICOM, DICOMDIR, NIFTI (.nii/.nii.gz/.hdr+.img), NRRD, PNG, JPEG, TIFF, ZIP · drop files or folders
                </div>
                {importMessage && (
                  <div data-testid="local-import-message" className="mt-2 text-sm text-cyan-100">
                    {importMessage}
                  </div>
                )}
                {importWarnings.length > 0 && (
                  <div className="mt-2 text-xs text-amber-200">
                    {importWarnings.join(" ")}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".dcm,.dicom,.nii,.nii.gz,.hdr,.img,.nrrd,.png,.jpg,.jpeg,.tif,.tiff,.zip,DICOMDIR"
                  className="hidden"
                  onChange={(event) => void handleLocalImport(event.currentTarget.files)}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => void handleLocalImport(event.currentTarget.files)}
                  {...directoryInputProps}
                />
                <button
                  type="button"
                  disabled={importing}
                  onClick={() => void handleDesktopLocalImport("files")}
                  className="inline-flex items-center gap-2 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm text-cyan-100 transition hover:bg-cyan-300/20 disabled:cursor-wait disabled:opacity-70"
                >
                  {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Import files
                </button>
                <button
                  type="button"
                  disabled={importing}
                  onClick={() => void handleDesktopLocalImport("folder")}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm text-slate-200 transition hover:border-cyan-400/50 hover:text-white disabled:cursor-wait disabled:opacity-70"
                >
                  <FolderOpen className="h-4 w-4" />
                  Import folder
                </button>
              </div>
            </div>
          )}

          {biomedParseDemoCapabilities?.enabled && (
            <div
              data-testid="biomedparse-demo-panel"
              className="mt-6 rounded-2xl border border-violet-300/30 bg-slate-950/70 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-violet-200/80">
                    <Activity className="h-4 w-4" />
                    BioMedParse demo
                  </div>
                  <div className="mt-2 text-base font-medium text-white">
                    {biomedParseDemoCapabilities.ready ? "Bundled CT sample ready" : "Worker unavailable"}
                  </div>
                  <div className="mt-1 text-sm text-slate-300">
                    {biomedParseDemoCapabilities.ready
                      ? `${biomedParseDemoCapabilities.modelId} · ${biomedParseDemoCapabilities.license}`
                      : biomedParseDemoCapabilities.reason}
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="run-biomedparse-demo"
                  disabled={!biomedParseDemoCapabilities.ready || biomedParseDemoRunning}
                  onClick={() => void handleRunBiomedParseDemo()}
                  className="inline-flex items-center gap-2 rounded-full border border-violet-200/40 bg-violet-300/10 px-4 py-2 text-sm text-violet-100 transition hover:bg-violet-300/20 disabled:cursor-wait disabled:opacity-60"
                >
                  {biomedParseDemoRunning ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Activity className="h-4 w-4" />
                  )}
                  Run CT demo
                </button>
              </div>

              {biomedParseDemoError && (
                <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {biomedParseDemoError}
                </div>
              )}

              {biomedParseDemoResult && (
                <div
                  data-testid="biomedparse-demo-result"
                  className="mt-4 grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)]"
                >
                  <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
                    <img
                      src={resolveClinicalApiUrl(biomedParseDemoResult.artifacts.previewPngUrl)}
                      alt=""
                      className="aspect-square h-full w-full object-cover"
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="grid gap-2 sm:grid-cols-3">
                      <MetricChip label="Mask" value={biomedParseDemoResult.maskShape.join(" × ")} />
                      <MetricChip label="Voxels" value={biomedParseDemoResult.nonzeroVoxels.toLocaleString()} />
                      <MetricChip
                        label="VRAM"
                        value={
                          biomedParseDemoResult.runtime.peakVramGib == null
                            ? "n/a"
                            : `${biomedParseDemoResult.runtime.peakVramGib.toFixed(2)} GiB`
                        }
                      />
                    </div>
                    <div className="mt-3 text-xs text-slate-400">
                      Run {biomedParseDemoResult.runId} · slice {biomedParseDemoResult.previewSlice + 1} · inference{" "}
                      {biomedParseDemoResult.timings.inferenceSeconds?.toFixed(2) ?? "n/a"}s
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {biomedParseDemoResult.labels
                        .filter((label) => label.voxelCount > 0)
                        .slice(0, 8)
                        .map((label) => (
                          <span
                            key={`${biomedParseDemoResult.runId}-${label.label}`}
                            className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs text-slate-200"
                            title={label.prompt}
                          >
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: label.color }}
                            />
                            <span className="truncate">
                              {label.label}: {label.voxelCount.toLocaleString()}
                            </span>
                          </span>
                        ))}
                    </div>
                    <a
                      href={resolveClinicalApiUrl(biomedParseDemoResult.artifacts.maskNpzUrl)}
                      className="mt-3 inline-flex text-sm text-violet-200 underline-offset-4 hover:underline"
                    >
                      Download mask NPZ
                    </a>
                  </div>
                </div>
              )}
            </div>
          )}

          {localStudyAssets && (
            <div
              data-testid="local-assets-panel"
              className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-cyan-300/70">
                    <FileSearch className="h-4 w-4" />
                    Local study assets
                  </div>
                  <div className="mt-2 text-base font-medium text-white">
                    {localStudyAssets.description}
                  </div>
                  <div className="mt-1 text-sm text-slate-300">{localStudyAssets.summary}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="analyze-local-study"
                    onClick={() => void handleAnalyzeLocalStudy(localStudyAssets.studyInstanceUID)}
                    className="inline-flex items-center gap-2 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm text-cyan-100 transition hover:bg-cyan-300/20 disabled:cursor-wait disabled:opacity-70"
                    disabled={analyzingStudyUid === localStudyAssets.studyInstanceUID}
                  >
                    {analyzingStudyUid === localStudyAssets.studyInstanceUID ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Activity className="h-4 w-4" />
                    )}
                    Analyze
                  </button>
                  <button
                    type="button"
                    aria-label="Close local study assets"
                    onClick={() => {
                      setLocalStudyAssets(null);
                      setLocalStudyAnalysis(null);
                    }}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-700 bg-slate-900/70 text-slate-300 transition hover:border-cyan-400/50 hover:text-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {localStudyAssets.warnings.length > 0 && (
                <div className="mt-3 text-xs text-amber-200">
                  {localStudyAssets.warnings.join(" ")}
                </div>
              )}

              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {localStudyAssets.findings.map((finding, index) => (
                  <div
                    key={`${finding.label}-${finding.value}-${index}`}
                    className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2"
                  >
                    <div className="text-xs uppercase tracking-[0.14em] text-slate-500">
                      {finding.label}
                    </div>
                    <div className="mt-1 break-words text-sm text-slate-100">{finding.value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-4 divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800">
                {localStudyAssets.assets.map((asset) => {
                  const previewState = getNiftiPreviewState(
                    asset,
                    niftiPreviewStates[asset.assetId],
                  );
                  const previewPath = buildAssetPreviewPath(asset, previewState);
                  const previewAxes = Object.keys(asset.previewSlices);
                  const sliceCount = asset.previewSlices[previewState.axis] ?? 0;
                  const showNiftiControls = asset.format === "nifti" && previewAxes.length > 0;

                  return (
                    <div
                      key={asset.assetId}
                      className="grid gap-3 bg-slate-950/40 px-3 py-3 text-sm text-slate-300 md:grid-cols-[104px_minmax(0,1fr)_92px_92px]"
                    >
                      <div className="flex h-20 w-24 items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-slate-900/80">
                        {asset.previewSupported && previewPath ? (
                          <img
                            data-testid="local-asset-preview"
                            src={resolveClinicalApiUrl(previewPath)}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <span className="px-2 text-center text-xs uppercase tracking-[0.14em] text-cyan-300/70">
                            {asset.format}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 self-center">
                        <div className="text-xs uppercase tracking-[0.14em] text-cyan-300/70">
                          {asset.format}
                        </div>
                        <div className="mt-1 break-all text-slate-100">{asset.relativePath}</div>
                        {showNiftiControls && (
                          <div className="mt-3 grid gap-2">
                            <div className="flex flex-wrap gap-1">
                              {previewAxes.map((axis) => (
                                <button
                                  key={`${asset.assetId}-${axis}`}
                                  type="button"
                                  onClick={() => updateNiftiPreviewState(asset, { axis })}
                                  className={`rounded-full border px-3 py-1 text-xs uppercase tracking-[0.12em] transition ${
                                    previewState.axis === axis
                                      ? "border-cyan-300/50 bg-cyan-300/15 text-cyan-100"
                                      : "border-slate-700 bg-slate-900/70 text-slate-300 hover:border-cyan-400/50"
                                  }`}
                                >
                                  {axis}
                                </button>
                              ))}
                            </div>
                            <div className="grid gap-1">
                              <div className="text-xs text-slate-500">
                                Slice {previewState.slice + 1} / {Math.max(sliceCount, 1)}
                              </div>
                              <input
                                type="range"
                                min={0}
                                max={Math.max(sliceCount - 1, 0)}
                                value={previewState.slice}
                                onChange={(event) => updateNiftiPreviewState(
                                  asset,
                                  { slice: Number(event.currentTarget.value) },
                                )}
                                className="h-2 w-full accent-cyan-300"
                                aria-label={`${previewState.axis} slice`}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="self-center">{formatFileSize(asset.size)}</div>
                      <div className="self-center">
                        {asset.viewerSupported ? "Viewer" : asset.analysisSupported ? "Analysis" : "Stored"}
                      </div>
                    </div>
                  );
                })}
              </div>

              {localStudyAnalysis && (
                <div
                  data-testid="local-analysis-panel"
                  className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-cyan-300/70">
                      <Activity className="h-4 w-4" />
                      Local analysis
                    </div>
                    <div className="text-xs text-slate-500">
                      {new Date(localStudyAnalysis.analyzedAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="mt-2 text-sm text-slate-300">{localStudyAnalysis.summary}</div>
                  {localStudyAnalysis.warnings.length > 0 && (
                    <div className="mt-2 text-xs text-amber-200">
                      {localStudyAnalysis.warnings.join(" ")}
                    </div>
                  )}
                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    {localStudyAnalysis.analyses.map((analysis) => (
                      <div
                        key={analysis.assetId}
                        className="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
                      >
                        <div className="text-xs uppercase tracking-[0.14em] text-cyan-300/70">
                          {analysis.format}
                        </div>
                        <div className="mt-1 break-all text-sm font-medium text-white">
                          {analysis.relativePath}
                        </div>
                        <div className="mt-1 text-sm text-slate-300">{analysis.summary}</div>
                        {analysis.warnings.length > 0 && (
                          <div className="mt-2 text-xs text-amber-200">
                            {analysis.warnings.join(" ")}
                          </div>
                        )}
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {analysis.metrics.map((metric) => (
                            <div
                              key={`${analysis.assetId}-${metric.label}-${metric.value}`}
                              className="rounded-md border border-slate-800 bg-slate-950/70 px-3 py-2"
                            >
                              <div className="text-xs uppercase tracking-[0.12em] text-slate-500">
                                {metric.label}
                              </div>
                              <div className="mt-1 break-words text-sm text-slate-100">
                                {metric.value}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mt-8 grid gap-4">
            {rows.map((row) => (
              <div
                data-testid="worklist-row"
                key={row.studyInstanceUID}
                className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-950/70 p-5 lg:grid-cols-[1.7fr_1fr_auto]"
              >
                <div>
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-cyan-300/70">
                    <Stethoscope className="h-4 w-4" />
                    {row.modality} study
                  </div>
                  <div className="mt-2 text-lg font-medium text-white">{row.description}</div>
                  <div className="mt-3 flex flex-wrap gap-3 text-sm text-slate-300">
                    <span>Accession {row.accessionNumber}</span>
                    <span>Patient {row.patientRef}</span>
                    <span>Status {row.status}</span>
                  </div>
                  <div className="mt-3 text-xs text-slate-400">
                    Study UID {row.studyInstanceUID}
                  </div>
                </div>

                <div className="space-y-2 text-sm text-slate-300">
                  <div>Priors {row.priorStudyUIDs.length}</div>
                  <div>
                    Triage score{" "}
                    {row.triageScore == null ? "Unavailable" : row.triageScore.toFixed(2)}
                  </div>
                  <div>Archive {row.archiveRef}</div>
                  <div>Updated {new Date(row.lastUpdatedAt).toLocaleString()}</div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 lg:flex-col lg:items-stretch">
                  {row.archiveRef.startsWith("local://") && (
                    <button
                      type="button"
                      data-testid="inspect-local-study"
                      onClick={() => void handleInspectLocalStudy(row)}
                      className="inline-flex items-center justify-center gap-2 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-3 text-sm font-medium text-cyan-100 transition hover:bg-cyan-300/20 disabled:cursor-wait disabled:opacity-70"
                      disabled={inspectingStudyUid === row.studyInstanceUID}
                    >
                      {inspectingStudyUid === row.studyInstanceUID ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <FileSearch className="h-4 w-4" />
                      )}
                      Inspect files
                    </button>
                  )}
                  {(!row.archiveRef.startsWith("local://") ||
                    !["NIFTI", "IMG"].includes(row.modality.toUpperCase())) && (
                    <button
                      type="button"
                      data-testid="open-viewer"
                      onClick={() => void handleOpenViewer(row)}
                      className="rounded-full bg-cyan-300 px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-70"
                      disabled={launchingStudyUid === row.studyInstanceUID}
                    >
                      {launchingStudyUid === row.studyInstanceUID ? (
                        <span className="inline-flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Launching
                        </span>
                      ) : (
                        "Open viewer"
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-xs uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div className="mt-1 break-words text-sm text-slate-100">{value}</div>
    </div>
  );
}

function formatFileSize(sizeBytes: number): string {
  let value = Math.max(sizeBytes, 0);
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (value < 1024 || unit === "GB") {
      return unit === "B" ? `${Math.round(value)} B` : `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${value.toFixed(1)} GB`;
}

function buildAssetPreviewPath(
  asset: LocalImagingStudyAsset,
  previewState: NiftiPreviewState,
): string | null {
  if (!asset.previewUrl) {
    return null;
  }
  if (asset.format !== "nifti" || !Object.keys(asset.previewSlices).length) {
    return asset.previewUrl;
  }
  const params = new URLSearchParams({
    axis: previewState.axis,
    slice: String(previewState.slice),
  });
  return `${asset.previewUrl}?${params.toString()}`;
}

function getNiftiPreviewState(
  asset: LocalImagingStudyAsset,
  current?: NiftiPreviewState,
): NiftiPreviewState {
  const previewSlices = asset.previewSlices ?? {};
  const firstAxis = Object.keys(previewSlices)[0] ?? "axial";
  const defaultAxis = asset.defaultPreviewAxis && previewSlices[asset.defaultPreviewAxis]
    ? asset.defaultPreviewAxis
    : firstAxis;
  const axis = current?.axis && previewSlices[current.axis]
    ? current.axis
    : defaultAxis;
  const sliceCount = Math.max(previewSlices[axis] ?? 1, 1);
  const defaultSlice = asset.defaultPreviewSlice ?? Math.floor(sliceCount / 2);
  return {
    axis,
    slice: clamp(current?.slice ?? defaultSlice, 0, sliceCount - 1),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const itemEntries = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map(getBrowserFileSystemEntry)
    .filter(isBrowserFileSystemEntry);

  if (!itemEntries.length) {
    return Array.from(dataTransfer.files);
  }

  const files = await Promise.all(itemEntries.map((entry) => filesFromEntry(entry)));
  return files.flat();
}

async function filesFromEntry(
  entry: BrowserFileSystemEntry,
  parentRelativePath = "",
): Promise<File[]> {
  const relativePath = joinRelativePath(parentRelativePath, entry.name);

  if (entry.isFile) {
    return [await fileFromFileEntry(entry as BrowserFileSystemFileEntry, relativePath)];
  }

  if (!entry.isDirectory) {
    return [];
  }

  const childEntries = await readDirectoryEntries(entry as BrowserFileSystemDirectoryEntry);
  const nestedFiles = await Promise.all(
    childEntries.map((childEntry) => filesFromEntry(childEntry, relativePath)),
  );
  return nestedFiles.flat();
}

function fileFromFileEntry(
  entry: BrowserFileSystemFileEntry,
  relativePath: string,
): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve(fileWithRelativePath(file, relativePath || file.name)),
      reject,
    );
  });
}

function readDirectoryEntries(
  entry: BrowserFileSystemDirectoryEntry,
): Promise<BrowserFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: BrowserFileSystemEntry[] = [];

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

function getBrowserFileSystemEntry(item: DataTransferItem): BrowserFileSystemEntry | null {
  const entry = (item as BrowserDataTransferItem).webkitGetAsEntry?.() ?? null;
  return isBrowserFileSystemEntry(entry) ? entry : null;
}

function isBrowserFileSystemEntry(
  entry: unknown,
): entry is BrowserFileSystemEntry {
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

function fileWithRelativePath(file: File, relativePath: string): File {
  const fileWithPath = file as File & { radsysxRelativePath?: string };
  Object.defineProperty(fileWithPath, "radsysxRelativePath", {
    configurable: true,
    value: relativePath || file.name,
  });
  return fileWithPath;
}

function joinRelativePath(parentPath: string, name: string): string {
  const cleanParent = parentPath.replace(/^\/+|\/+$/g, "");
  const cleanName = name.replace(/^\/+|\/+$/g, "");
  return cleanParent ? `${cleanParent}/${cleanName}` : cleanName;
}

function desktopPickedFileToFile(part: DesktopPickedFile): File {
  const file = new File([toBlobPart(part.data)], part.name, {
    lastModified: part.lastModified,
    type: part.type || "application/octet-stream",
  });
  return fileWithRelativePath(file, part.relativePath || part.name);
}

function toBlobPart(data: ArrayBuffer | ArrayBufferView): BlobPart {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  const source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
}
