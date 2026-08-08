import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(__filename), "..");
const workspaceRoot = path.resolve(desktopRoot, "..");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radsysx-desktop-ui-import-smoke-"));
const fixtureRoot = path.join(tmpRoot, "fixtures");
const storageRoot = path.join(tmpRoot, "local-imaging-data");
const dbPath = path.join(tmpRoot, "clinical.db");
const maxStartupMs = Number.parseInt(process.env.RADSYSX_UI_IMPORT_SMOKE_STARTUP_MS ?? "120000", 10);
const manyDicomCount = 32;
const smokeMode = resolveSmokeMode();
const pickerSmokeModes = new Set([
  "local-start-nondicom",
  "picker-files",
  "picker-folder",
  "picker-large-folder",
  "picker-many-folder",
]);

let desktopProcess = null;
let desktopPublicBaseUrl = null;

function resolveSmokeMode() {
  if (process.argv.includes("--local-start-nondicom")) {
    return "local-start-nondicom";
  }
  if (process.argv.includes("--local-start-drop")) {
    return "local-start-drop";
  }
  if (process.argv.includes("--local-start")) {
    return "local-start";
  }
  if (process.argv.includes("--viewer-launch")) {
    return "viewer-launch";
  }
  if (process.argv.includes("--picker-many-folder")) {
    return "picker-many-folder";
  }
  if (process.argv.includes("--picker-large-folder")) {
    return "picker-large-folder";
  }
  if (process.argv.includes("--picker-files")) {
    return "picker-files";
  }
  if (process.argv.includes("--picker-folder")) {
    return "picker-folder";
  }
  return "drag-drop";
}

async function main() {
  try {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(storageRoot, { recursive: true });

    generateFixtures(fixtureRoot, {
      largePayload: smokeMode === "picker-large-folder",
      manyDicomCount: smokeMode === "picker-many-folder" ? manyDicomCount : 0,
    });
    const runtime = await startDesktopRuntime();
    const result = await runUiImportSmoke(runtime.publicBaseUrl, runtime.debugPort);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  } finally {
    await stopDesktopRuntime();
    if (process.env.RADSYSX_KEEP_UI_IMPORT_SMOKE_TMP === "1") {
      console.log(`Kept UI smoke workspace at ${tmpRoot}`);
    } else {
      fs.rmSync(tmpRoot, { force: true, recursive: true });
    }
  }
}

function electronCommand() {
  return path.join(
    workspaceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron",
  );
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

function asFileUrlPath(filePath) {
  return filePath.replaceAll("\\", "/");
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

function generateFixtures(outputDir, { largePayload = false, manyDicomCount = 0 } = {}) {
  const python = spawnSync(
    pythonCommand(),
    [
      "-c",
      `
import base64
import gzip
import struct
import sys
import zipfile
from pathlib import Path

import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, MediaStorageDirectoryStorage, generate_uid

root = Path(sys.argv[1])
large_payload = sys.argv[2] == "large"
many_dicom_count = int(sys.argv[3])
root.mkdir(parents=True, exist_ok=True)

study_uid = "1.2.826.0.1.3680043.10.54321.910"
series_uid = "1.2.826.0.1.3680043.10.54321.911"
sop_uid = "1.2.826.0.1.3680043.10.54321.912"

file_meta = FileMetaDataset()
file_meta.MediaStorageSOPClassUID = CTImageStorage
file_meta.MediaStorageSOPInstanceUID = sop_uid
file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

dataset = FileDataset(None, {}, file_meta=file_meta, preamble=b"\\0" * 128)
dataset.SOPClassUID = CTImageStorage
dataset.SOPInstanceUID = sop_uid
dataset.StudyInstanceUID = study_uid
dataset.SeriesInstanceUID = series_uid
dataset.Modality = "CT"
dataset.PatientID = "SMOKE-DO-NOT-LOG"
dataset.Rows = 2
dataset.Columns = 2
dataset.SamplesPerPixel = 1
dataset.PhotometricInterpretation = "MONOCHROME2"
dataset.BitsAllocated = 8
dataset.BitsStored = 8
dataset.HighBit = 7
dataset.PixelRepresentation = 0
dataset.PixelData = bytes([0, 1, 2, 3])
dataset.is_little_endian = True
dataset.is_implicit_VR = False
dataset.save_as(root / "SCAN1DCM", enforce_file_format=True)

if many_dicom_count:
    many_root = root / "nested-dicom" / "series-a"
    many_root.mkdir(parents=True, exist_ok=True)
    many_series_uid = "1.2.826.0.1.3680043.10.54321.913"
    for index in range(1, many_dicom_count + 1):
        many_sop_uid = f"1.2.826.0.1.3680043.10.54321.{2000 + index}"
        many_meta = FileMetaDataset()
        many_meta.MediaStorageSOPClassUID = CTImageStorage
        many_meta.MediaStorageSOPInstanceUID = many_sop_uid
        many_meta.TransferSyntaxUID = ExplicitVRLittleEndian

        many_dataset = FileDataset(None, {}, file_meta=many_meta, preamble=b"\\0" * 128)
        many_dataset.SOPClassUID = CTImageStorage
        many_dataset.SOPInstanceUID = many_sop_uid
        many_dataset.StudyInstanceUID = study_uid
        many_dataset.SeriesInstanceUID = many_series_uid
        many_dataset.Modality = "CT"
        many_dataset.PatientID = "SMOKE-DO-NOT-LOG"
        many_dataset.InstanceNumber = index + 1
        many_dataset.Rows = 2
        many_dataset.Columns = 2
        many_dataset.SamplesPerPixel = 1
        many_dataset.PhotometricInterpretation = "MONOCHROME2"
        many_dataset.BitsAllocated = 8
        many_dataset.BitsStored = 8
        many_dataset.HighBit = 7
        many_dataset.PixelRepresentation = 0
        many_dataset.PixelData = bytes(((index + offset) % 256 for offset in range(4)))
        many_dataset.is_little_endian = True
        many_dataset.is_implicit_VR = False
        many_dataset.save_as(many_root / f"IM{index:06d}", enforce_file_format=True)

directory_meta = FileMetaDataset()
directory_meta.MediaStorageSOPClassUID = MediaStorageDirectoryStorage
directory_meta.MediaStorageSOPInstanceUID = generate_uid()
directory_meta.TransferSyntaxUID = ExplicitVRLittleEndian

dicomdir = FileDataset(None, {}, file_meta=directory_meta, preamble=b"\\0" * 128)
dicomdir.SOPClassUID = MediaStorageDirectoryStorage
dicomdir.SOPInstanceUID = directory_meta.MediaStorageSOPInstanceUID
dicomdir.is_little_endian = True
dicomdir.is_implicit_VR = False
record = Dataset()
record.DirectoryRecordType = "IMAGE"
record.ReferencedFileID = ["SCAN1DCM"]
dicomdir.DirectoryRecordSequence = Sequence([record])
dicomdir.save_as(root / "DICOMDIR", enforce_file_format=True)

header = bytearray(352)
header[0:4] = (348).to_bytes(4, "little")
header[40:56] = struct.pack("<8h", 3, 2, 3, 4, 1, 1, 1, 1)
header[70:72] = (2).to_bytes(2, "little", signed=True)
header[72:74] = (8).to_bytes(2, "little", signed=True)
header[108:112] = struct.pack("<f", 352.0)
header[344:348] = b"n+1\\0"
voxels = bytes(range(24))
(root / "volume.nii").write_bytes(bytes(header) + voxels)
(root / "volume.nii.gz").write_bytes(gzip.compress(bytes(header) + voxels))
paired_header = bytearray(header)
paired_header[108:112] = struct.pack("<f", 0.0)
paired_header[344:348] = b"ni1\\0"
(root / "paired.hdr").write_bytes(bytes(paired_header))
(root / "paired.img").write_bytes(voxels)
nrrd_bytes = (
    b"NRRD0005\\n"
    b"# synthetic PHI-free local imaging UI smoke volume\\n"
    b"type: uint8\\n"
    b"dimension: 3\\n"
    b"sizes: 2 3 4\\n"
    b"encoding: raw\\n"
    b"endian: little\\n\\n"
    + voxels
)
(root / "segmentation.nrrd").write_bytes(nrrd_bytes)
if large_payload:
    large_header = bytearray(352)
    large_header[0:4] = (348).to_bytes(4, "little")
    large_header[40:56] = struct.pack("<8h", 3, 256, 256, 128, 1, 1, 1, 1)
    large_header[70:72] = (2).to_bytes(2, "little", signed=True)
    large_header[72:74] = (8).to_bytes(2, "little", signed=True)
    large_header[108:112] = struct.pack("<f", 352.0)
    large_header[344:348] = b"n+1\\0"
    pattern = bytes(range(256))
    remaining = 256 * 256 * 128
    with (root / "large-volume.nii").open("wb") as handle:
        handle.write(bytes(large_header))
        while remaining > 0:
            chunk = pattern[: min(len(pattern), remaining)]
            handle.write(chunk)
            remaining -= len(chunk)
png_bytes = (
    b"\\x89PNG\\r\\n\\x1a\\n"
    b"\\x00\\x00\\x00\\rIHDR"
    b"\\x00\\x00\\x00\\x01\\x00\\x00\\x00\\x01\\x08\\x02\\x00\\x00\\x00"
    b"\\x90wS\\xde"
    b"\\x00\\x00\\x00\\x0cIDATx\\x9cc\\xf8\\xff\\xff?\\x00\\x05\\xfe\\x02\\xfe"
    b"\\xdc\\xccY\\xe7"
    b"\\x00\\x00\\x00\\x00IEND\\xaeB\\x60\\x82"
)
(root / "slice.png").write_bytes(png_bytes)
(root / "slice.jpeg").write_bytes(base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUG"
    "CQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA"
    "/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEA"
    "AD8AVN//2Q=="
))
tiff_entries = [
    struct.pack("<HHI", 256, 4, 1) + struct.pack("<I", 2),
    struct.pack("<HHI", 257, 4, 1) + struct.pack("<I", 3),
    struct.pack("<HHI", 258, 3, 1) + struct.pack("<H", 8) + b"\\x00\\x00",
]
(root / "slice.tiff").write_bytes(
    b"II"
    + struct.pack("<HI", 42, 8)
    + struct.pack("<H", len(tiff_entries))
    + b"".join(tiff_entries)
    + struct.pack("<I", 0)
)
with zipfile.ZipFile(root / "archive.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("zipped-volume.nii", bytes(header) + voxels)
    archive.writestr("zipped-slice.png", png_bytes)
`,
      outputDir,
      largePayload ? "large" : "standard",
      String(manyDicomCount),
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf-8",
    },
  );

  if (python.status !== 0) {
    throw new Error(
      [
        "Unable to generate local imaging UI smoke fixtures.",
        python.stdout,
        python.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function startDesktopRuntime() {
  const usedPorts = new Set();
  const appPort = await findAvailablePort(
    Number.parseInt(process.env.RADSYSX_DESKTOP_PORT ?? "37100", 10),
    usedPorts,
  );
  const frontendPort = await findAvailablePort(
    Number.parseInt(process.env.RADSYSX_DESKTOP_FRONTEND_PORT ?? "37110", 10),
    usedPorts,
  );
  const backendPort = await findAvailablePort(
    Number.parseInt(process.env.RADSYSX_DESKTOP_BACKEND_PORT ?? "37180", 10),
    usedPorts,
  );
  const debugPort = await findAvailablePort(
    Number.parseInt(process.env.RADSYSX_DESKTOP_DEBUG_PORT ?? "37190", 10),
    usedPorts,
  );

  const env = {
    ...process.env,
    RADSYSX_DESKTOP_PORT: String(appPort),
    RADSYSX_DESKTOP_FRONTEND_PORT: String(frontendPort),
    RADSYSX_DESKTOP_BACKEND_PORT: String(backendPort),
    RADSYSX_LOCAL_IMAGING_ENABLED: "true",
    RADSYSX_LOCAL_IMAGING_STORAGE_DIR: storageRoot,
    RADSYSX_CLINICAL_DATABASE_URL: `sqlite:///${asFileUrlPath(dbPath)}`,
    RADSYSX_SESSION_COOKIE_SECURE: "false",
    RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN: "1",
    RADSYSX_DESKTOP_REBUILD_FRONTEND: process.env.RADSYSX_DESKTOP_REBUILD_FRONTEND ?? "1",
    ...(pickerSmokeModes.has(smokeMode)
      ? { RADSYSX_DESKTOP_PICKER_TEST_PATHS: JSON.stringify(pickerTestPathsForSmokeMode()) }
      : {}),
  };

  return new Promise((resolve, reject) => {
    desktopProcess = spawn(
      electronCommand(),
      ["--no-sandbox", `--remote-debugging-port=${debugPort}`, desktopRoot],
      {
        cwd: workspaceRoot,
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const startedAt = Date.now();
    let settled = false;
    const logs = [];
    const timeout = setInterval(() => {
      if (settled) {
        return;
      }
      if (Date.now() - startedAt > maxStartupMs) {
        settled = true;
        clearInterval(timeout);
        reject(new Error(`Desktop runtime did not become ready.\n${logs.slice(-80).join("\n")}`));
      }
    }, 500);
    timeout.unref();

    const handleOutput = (scope, chunk) => {
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const entry = `[${scope}] ${line}`;
        logs.push(entry);
        console.log(entry);
        const match = line.match(/RadSysX desktop is ready at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match && !settled) {
          settled = true;
          desktopPublicBaseUrl = match[1];
          clearInterval(timeout);
          resolve({ publicBaseUrl: match[1], debugPort });
        }
      }
    };

    desktopProcess.stdout?.on("data", (chunk) => handleOutput("desktop", chunk));
    desktopProcess.stderr?.on("data", (chunk) => handleOutput("desktop", chunk));
    desktopProcess.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearInterval(timeout);
        reject(error);
      }
    });
    desktopProcess.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearInterval(timeout);
        reject(new Error(`Desktop runtime exited early with ${signal ?? code ?? "unknown"}.`));
      }
    });
  });
}

async function runUiImportSmoke(publicBaseUrl, debugPort) {
  const target = await waitForDebugTarget(debugPort);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails;
      const location = details?.url
        ? `${details.url}:${(details.lineNumber ?? 0) + 1}:${(details.columnNumber ?? 0) + 1}`
        : "";
      const description = details?.exception?.description ?? details?.text;
      if (description) {
        console.log(`[renderer:exception] ${location} ${description}`.trim());
      }
    });
    await waitForRendererCondition(
      cdp,
      `window.location.origin === ${JSON.stringify(publicBaseUrl)} &&
        document.readyState !== "loading"`,
      "settled desktop renderer",
    );

    if (smokeMode === "local-start") {
      const localStartResult = await runLocalStartSmoke(cdp, publicBaseUrl);
      return {
        ok: true,
        smokeMode,
        publicBaseUrl,
        ...localStartResult,
      };
    }
    if (smokeMode === "local-start-drop") {
      const localStartResult = await runLocalStartDropSmoke(cdp, publicBaseUrl);
      return {
        ok: true,
        smokeMode,
        publicBaseUrl,
        ...localStartResult,
      };
    }
    if (smokeMode === "local-start-nondicom") {
      const localStartResult = await runLocalStartNonDicomSmoke(cdp, publicBaseUrl);
      return {
        ok: true,
        smokeMode,
        publicBaseUrl,
        ...localStartResult,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    await evaluateInRenderer(
      cdp,
      `fetch("/api/auth/local-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: "demo-radiologist" })
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.status;
      })`,
      30000,
    );
    await evaluateInRenderer(
      cdp,
      `window.location.assign("/worklist")`,
      30000,
    );
    await waitForRendererCondition(
      cdp,
      `window.location.pathname === "/worklist" &&
        Boolean(document.querySelector('[data-testid="local-import-panel"]'))`,
      "hydrated worklist local import panel",
    );

    const result = await evaluateInRenderer(
      cdp,
      `(${uiSmokeInRenderer.toString()})(${JSON.stringify(readFixturePayloads())}, ${JSON.stringify(smokeMode)})`,
      120000,
    );
    const viewerLaunch = smokeMode === "viewer-launch"
      ? await verifyImportedDicomViewerLaunch(cdp, result.dicomStudyUid)
      : null;

    return {
      ok: true,
      smokeMode,
      publicBaseUrl,
      ...result,
      ...(viewerLaunch ? { viewerLaunch } : {}),
    };
  } finally {
    cdp.close();
  }
}

async function runLocalStartSmoke(cdp, publicBaseUrl) {
  const localViewerState = await waitForStandaloneLocalViewer(cdp, publicBaseUrl);
  const importState = await evaluateInRenderer(
    cdp,
    `(${loadOhifLocalDicomInputInRenderer.toString()})(${JSON.stringify(readDicomFixturePayloads())})`,
    30000,
  );

  const viewerState = await verifyStandaloneLocalDicomViewer(cdp);
  return {
    importPath: "ohif-local-input",
    localViewerState,
    importState,
    viewerState,
  };
}

async function runLocalStartDropSmoke(cdp, publicBaseUrl) {
  const localViewerState = await waitForStandaloneLocalViewer(cdp, publicBaseUrl);
  const dropState = await evaluateInRenderer(
    cdp,
    `(${dispatchOhifLocalDicomDropInRenderer.toString()})(${JSON.stringify(readDicomFixturePayloads())})`,
    30000,
  );

  const viewerState = await verifyStandaloneLocalDicomViewer(cdp);
  return {
    importPath: "ohif-local-drop",
    localViewerState,
    dropState,
    viewerState,
  };
}

async function runLocalStartNonDicomSmoke(cdp, publicBaseUrl) {
  const localViewerState = await waitForStandaloneLocalViewer(cdp, publicBaseUrl);
  await evaluateInRenderer(
    cdp,
    `fetch("/api/auth/local-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username: "demo-radiologist" })
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(await response.text());
      }
      window.location.assign("/worklist");
      return response.status;
    })`,
    30000,
  );

  await waitForRendererCondition(
    cdp,
    `window.location.pathname === "/worklist" &&
      Boolean(document.querySelector('[data-testid="local-import-panel"]'))`,
    "local-start non-DICOM worklist import panel",
    90000,
  );
  await evaluateInRenderer(cdp, `(${clickWorklistImportFilesInRenderer.toString()})()`, 30000);
  await waitForRendererCondition(
    cdp,
    `window.location.pathname === "/worklist" &&
      Array.from(document.querySelectorAll('[data-testid="worklist-row"]'))
        .some((row) => row.innerText.includes("Local NIFTI import") &&
          Boolean(row.querySelector('[data-testid="inspect-local-study"]')))`,
    "local-start non-DICOM worklist row",
    90000,
  );
  await evaluateInRenderer(cdp, `(${clickLocalNiftiInspectInRenderer.toString()})()`, 30000);
  await waitForRendererCondition(
    cdp,
    `window.location.pathname === "/worklist" &&
      Boolean(document.querySelector('[data-testid="local-assets-panel"]'))`,
    "local-start non-DICOM worklist inspection panel",
    90000,
  );

  const inspection = await evaluateInRenderer(
    cdp,
    `(${localStartNonDicomInspectionInRenderer.toString()})()`,
    120000,
  );

  return {
    importPath: "ohif-local-to-worklist-nondicom",
    localViewerState,
    inspection,
  };
}

async function waitForStandaloneLocalViewer(cdp, publicBaseUrl) {
  await waitForRendererCondition(
    cdp,
    `window.location.origin === ${JSON.stringify(publicBaseUrl)} &&
      window.location.pathname === "/viewer/local" &&
      window.__RADSYSX_LOCAL_VIEWER_READY__ === true &&
      !document.getElementById("radsysx-loader") &&
      document.body.innerText.includes("Drag and drop your DICOM files")`,
    "desktop standalone OHIF local viewer",
    90000,
  );

  const localViewerState = await evaluateInRenderer(
    cdp,
    `(() => ({
      href: window.location.href,
      pathname: window.location.pathname,
      documentTitle: document.title,
      localQueryPresent: new URL(window.location.href).searchParams.has("local"),
      loaderPresent: Boolean(document.getElementById("radsysx-loader")),
      localViewerReady: window.__RADSYSX_LOCAL_VIEWER_READY__ === true,
      localViewer: window.__RADSYSX_LOCAL_VIEWER__ === true,
      launchPresent: Boolean(window.__RADSYSX_LAUNCH__),
      localStartCardPresent: Boolean(document.querySelector('[data-testid="radsysx-local-start-card"]')),
      localShellBackdropPresent: Boolean(document.getElementById("radsysx-local-shell-backdrop")),
      localUploadModalPresent: Boolean(document.querySelector('[data-radsysx-local-upload-modal="true"]')),
      loadFilesPresent: Array.from(document.querySelectorAll("button"))
        .some((button) => button.innerText.trim() === "Load files"),
      loadFoldersPresent: Array.from(document.querySelectorAll("button"))
        .some((button) => button.innerText.trim() === "Load folders"),
      bodyText: document.body.innerText.slice(0, 800)
    }))()`,
    30000,
  );

  if (localViewerState.localQueryPresent) {
    throw new Error(`Local query was not stripped from the visible viewer URL: ${localViewerState.href}`);
  }
  if (localViewerState.documentTitle !== "RadSysX") {
    throw new Error(`Viewer document title was not RadSysX: ${JSON.stringify(localViewerState)}`);
  }
  if (localViewerState.loaderPresent || localViewerState.localStartCardPresent) {
    throw new Error(`Desktop local viewer is still blocked by an intermediate overlay: ${JSON.stringify(localViewerState)}`);
  }
  if (!localViewerState.localShellBackdropPresent || !localViewerState.localUploadModalPresent) {
    throw new Error(`Desktop local viewer did not show the branded upload modal shell: ${JSON.stringify(localViewerState)}`);
  }
  if (!localViewerState.localViewerReady || !localViewerState.localViewer) {
    throw new Error(
      `Desktop local viewer did not expose standalone OHIF local state: ${JSON.stringify(localViewerState)}`,
    );
  }
  if (localViewerState.launchPresent) {
    throw new Error(`Desktop local viewer unexpectedly created a governed launch: ${JSON.stringify(localViewerState)}`);
  }
  if (!localViewerState.loadFilesPresent || !localViewerState.loadFoldersPresent) {
    throw new Error(`Desktop local viewer did not show OHIF local loading controls: ${JSON.stringify(localViewerState)}`);
  }
  return localViewerState;
}

function loadOhifLocalDicomInputInRenderer(fixtures) {
  const makeFile = (payload) => {
    const binary = atob(payload.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const file = new File([bytes], payload.name, { type: payload.type });
    Object.defineProperty(file, "radsysxRelativePath", {
      configurable: true,
      value: payload.relativePath,
    });
    return file;
  };

  const input = Array.from(document.querySelectorAll('input[type="file"]'))
    .find((candidate) => !candidate.webkitdirectory);
  if (!input) {
    throw new Error("OHIF local file input was missing.");
  }

  const transfer = new DataTransfer();
  for (const payload of fixtures) {
    transfer.items.add(makeFile(payload));
  }

  Object.defineProperty(input, "files", {
    configurable: true,
    value: transfer.files,
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));

  return {
    fileCount: transfer.files.length,
    inputCount: document.querySelectorAll('input[type="file"]').length,
    bodyText: document.body.innerText.slice(0, 500),
  };
}

function dispatchOhifLocalDicomDropInRenderer(fixtures) {
  const makeFile = (payload) => {
    const binary = atob(payload.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const file = new File([bytes], payload.name, { type: payload.type });
    Object.defineProperty(file, "radsysxRelativePath", {
      configurable: true,
      value: payload.relativePath,
    });
    return file;
  };

  const dropTarget = Array.from(document.querySelectorAll("div"))
    .find((candidate) => candidate.innerText?.includes("Drag and drop your DICOM files"));
  if (!dropTarget) {
    throw new Error("OHIF local DICOM drop target was missing.");
  }
  const targets = [];
  for (let node = dropTarget; node; node = node.parentElement) {
    targets.push(node);
    if (node === document.body) {
      break;
    }
  }

  const transfer = new DataTransfer();
  for (const payload of fixtures) {
    transfer.items.add(makeFile(payload));
  }
  transfer.dropEffect = "copy";
  transfer.effectAllowed = "copy";

  for (const target of targets) {
    target.dispatchEvent(new DragEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    target.dispatchEvent(new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    target.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }

  return {
    fileCount: transfer.files.length,
    targetCount: targets.length,
    targetText: dropTarget.innerText.slice(0, 500),
  };
}

function clickWorklistImportFilesInRenderer() {
  const textMatches = (value, needle) => value.toLowerCase().includes(needle.toLowerCase());
  const importPanel = document.querySelector('[data-testid="local-import-panel"]');
  if (!importPanel) {
    throw new Error("Worklist local import panel was missing.");
  }
  const button = Array.from(importPanel.querySelectorAll("button"))
    .find((candidate) => textMatches(candidate.innerText, "Import files"));
  if (!button) {
    throw new Error("Worklist Import files button was missing.");
  }
  button.click();
  return true;
}

function clickLocalNiftiInspectInRenderer() {
  const row = Array.from(document.querySelectorAll('[data-testid="worklist-row"]'))
    .find((candidate) => candidate.innerText.includes("Local NIFTI import"));
  const button = row?.querySelector('[data-testid="inspect-local-study"]');
  if (!button) {
    throw new Error("Local NIFTI inspect action was missing.");
  }
  button.click();
  return true;
}

async function verifyStandaloneLocalDicomViewer(cdp) {
  await waitForRendererCondition(
    cdp,
    `window.location.pathname === "/viewer/dicomlocal" &&
      new URL(window.location.href).searchParams.has("StudyInstanceUIDs") &&
      window.__RADSYSX_LOCAL_VIEWER__ === true &&
      !window.__RADSYSX_LAUNCH__ &&
      !document.getElementById("radsysx-loader")`,
    "standalone OHIF local DICOM viewer",
    90000,
  );

  const viewerState = await evaluateInRenderer(
    cdp,
    `(() => ({
      href: window.location.href,
      pathname: window.location.pathname,
      documentTitle: document.title,
      studyInstanceUIDs: new URL(window.location.href).searchParams.getAll("StudyInstanceUIDs"),
      datasources: new URL(window.location.href).searchParams.get("datasources"),
      localViewer: window.__RADSYSX_LOCAL_VIEWER__ === true,
      localViewerReady: window.__RADSYSX_LOCAL_VIEWER_READY__ === true,
      launchPresent: Boolean(window.__RADSYSX_LAUNCH__),
      loaderPresent: Boolean(document.getElementById("radsysx-loader")),
      workspacePanelPresent: Boolean(document.querySelector("radsysx-workspace-panel")),
      workspaceUnavailableTextSeen: document.body.innerText.includes("Viewer launch context is unavailable")
    }))()`,
    30000,
  );

  if (viewerState.launchPresent || viewerState.loaderPresent || viewerState.workspacePanelPresent) {
    throw new Error(`Standalone local viewer retained governed UI state: ${JSON.stringify(viewerState)}`);
  }
  if (viewerState.documentTitle !== "RadSysX") {
    throw new Error(`Standalone local viewer title was not RadSysX: ${JSON.stringify(viewerState)}`);
  }
  if (viewerState.workspaceUnavailableTextSeen) {
    throw new Error("Standalone local viewer showed governed workspace-unavailable copy.");
  }

  const renderProbe = await waitForViewerRenderProbe(cdp);
  const aiChatState = await verifyAiChatPanel(cdp);
  return {
    ...viewerState,
    renderProbe,
    aiChatState,
  };
}

async function verifyAiChatPanel(cdp) {
  const openState = await evaluateInRenderer(
    cdp,
    `(${openAiChatPanelInRenderer.toString()})()`,
    30000,
  );
  if (!openState.aiPanelRegistered) {
    throw new Error(`RadSysX AI panel was not registered: ${JSON.stringify(openState)}`);
  }
  if (!openState.aiTabPresent) {
    throw new Error(`RadSysX AI panel tab was not visible: ${JSON.stringify(openState)}`);
  }

  await waitForRendererCondition(
    cdp,
    `Boolean(document.querySelector("radsysx-ai-chat-panel textarea")) &&
      Boolean(document.querySelector("radsysx-ai-chat-panel [data-action='voice']")) &&
      Boolean(document.querySelector("radsysx-ai-chat-panel [data-action='toggle-mention']"))`,
    "RadSysX AI chat composer",
    30000,
  );
  await waitForRendererCondition(
    cdp,
    `document.querySelector("radsysx-ai-chat-panel")?.state?.backendStatus !== "connecting"`,
    "RadSysX AI backend binding",
    30000,
  );

  const chatState = await evaluateInRenderer(
    cdp,
    `(() => {
      const panel = document.querySelector("radsysx-ai-chat-panel");
      const textarea = panel?.querySelector("textarea");
      const mentionButton = panel?.querySelector("[data-action='toggle-mention']");
      const voiceButton = panel?.querySelector("[data-action='voice']");
      const voiceCard = panel?.querySelector(".radsysx-ai-voice-card");
      const sendButton = panel?.querySelector("button[type='submit']");
      mentionButton?.click();
      return {
        aiPanelPresent: Boolean(panel),
        composerPresent: Boolean(textarea),
        mentionButtonPresent: Boolean(mentionButton),
        voiceButtonPresent: Boolean(voiceButton),
        voiceCardPresent: Boolean(voiceCard),
        sendButtonPresent: Boolean(sendButton),
        backendStatus: panel?.state?.backendStatus ?? null,
        backendSessionPresent: Boolean(panel?.state?.backendSessionId),
        mentionMenuOpen: panel?.querySelector(".radsysx-ai-mention-menu")?.getAttribute("data-open") === "true",
        roiOptionPresent: Boolean(panel?.querySelector("[data-attachment-kind='roi']")),
        segmentationOptionPresent: Boolean(panel?.querySelector("[data-attachment-kind='segmentation']"))
      };
    })()`,
    30000,
  );

  if (
    !chatState.aiPanelPresent ||
    !chatState.composerPresent ||
    !chatState.mentionButtonPresent ||
    !chatState.voiceButtonPresent ||
    !chatState.voiceCardPresent ||
    !chatState.sendButtonPresent ||
    chatState.backendStatus !== "ready" ||
    !chatState.backendSessionPresent ||
    !chatState.mentionMenuOpen ||
    !chatState.roiOptionPresent ||
    !chatState.segmentationOptionPresent
  ) {
    throw new Error(`RadSysX AI chat composer was incomplete: ${JSON.stringify(chatState)}`);
  }

  return {
    ...openState,
    ...chatState,
  };
}

async function openAiChatPanelInRenderer() {
  const panelModules = window.__RADSYSX_OHIF_EXTENSION__?.getPanelModule?.() ?? [];
  const aiPanelRegistered = panelModules.some((module) => module?.name === "aiChat");
  const confirmButton = Array.from(document.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === "Confirm and hide");
  confirmButton?.click();
  if (confirmButton) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const controlCandidates = Array.from(
    document.querySelectorAll("button,[role='button'],[role='tab'],[aria-label],[title]"),
  );
  const aiTab = controlCandidates.find((candidate) => {
    const label = [
      candidate.getAttribute("aria-label"),
      candidate.getAttribute("title"),
      candidate.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    return /\bRadSysX AI\b/i.test(label) || /\bAI\b/.test(label);
  });

  const aiClickTarget = aiTab?.querySelector?.('[data-cy="aiChat-btn"]') ?? aiTab;
  aiClickTarget?.click();
  if (aiTab) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const state = {
    aiPanelRegistered,
    aiTabPresent: Boolean(aiTab),
    aiPanelPresent: Boolean(document.querySelector("radsysx-ai-chat-panel")),
    panelModuleNames: panelModules.map((module) => module?.name).filter(Boolean),
    aiTabLabel: aiTab?.getAttribute("aria-label") ?? aiTab?.getAttribute("title") ?? null,
  };
  window.__RADSYSX_AI_SMOKE_OPEN_STATE__ = state;
  return state;
}

async function verifyImportedDicomViewerLaunch(cdp, studyInstanceUid) {
  if (!studyInstanceUid) {
    throw new Error("Imported DICOM study UID was not returned by the UI smoke.");
  }

  await evaluateInRenderer(
    cdp,
    `(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="worklist-row"]'));
      const row = rows.find((candidate) => candidate.innerText.includes(${JSON.stringify(studyInstanceUid)}));
      if (!row) {
        throw new Error("Imported DICOM worklist row was not found for viewer launch.");
      }
      const button = row.querySelector('[data-testid="open-viewer"]');
      if (!button) {
        throw new Error("Open viewer action was not found for imported DICOM row.");
      }
      button.click();
      return true;
    })()`,
    30000,
  );

  return verifyResolvedImportedDicomViewer(cdp, studyInstanceUid);
}

async function verifyResolvedImportedDicomViewer(cdp, expectedStudyInstanceUid) {
  await waitForRendererCondition(
    cdp,
    `window.location.pathname.startsWith("/viewer") &&
      Boolean(window.__RADSYSX_BOOTSTRAP_PROMISE__) &&
      Boolean(window.__RADSYSX_LAUNCH__?.context?.studyInstanceUID)`,
    "resolved imported DICOM viewer bootstrap",
    90000,
  );

  const viewerState = await evaluateInRenderer(
    cdp,
    `(async () => {
      await window.__RADSYSX_BOOTSTRAP_PROMISE__;
      const launch = window.__RADSYSX_LAUNCH__;
      const runtime = window.__RADSYSX_VIEWER_RUNTIME__;
      const dicomwebSource = window.config?.dataSources?.find((entry) => entry?.sourceName === "dicomweb");
      return {
        href: window.location.href,
        pathname: window.location.pathname,
        launchQueryPresent: new URL(window.location.href).searchParams.has("launch"),
        loaderState: document.getElementById("radsysx-loader")?.dataset?.state ?? null,
        studyInstanceUID: launch?.context?.studyInstanceUID ?? null,
        viewerKind: runtime?.viewerKind ?? null,
        viewerBasePath: runtime?.viewerBasePath ?? null,
        qidoRoot: runtime?.qidoRoot ?? null,
        wadoRoot: runtime?.wadoRoot ?? null,
        configQidoRoot: dicomwebSource?.configuration?.qidoRoot ?? null,
        configWadoRoot: dicomwebSource?.configuration?.wadoRoot ?? null
      };
    })()`,
    90000,
  );

  const studyInstanceUid = expectedStudyInstanceUid ?? viewerState.studyInstanceUID;
  if (!studyInstanceUid) {
    throw new Error("Viewer launch did not resolve an imported DICOM study UID.");
  }
  if (expectedStudyInstanceUid && viewerState.studyInstanceUID !== expectedStudyInstanceUid) {
    throw new Error(
      `Viewer launch resolved ${viewerState.studyInstanceUID}, expected ${expectedStudyInstanceUid}.`,
    );
  }
  if (viewerState.launchQueryPresent) {
    throw new Error("Viewer launch token remained in the URL after bootstrap.");
  }
  if (viewerState.loaderState && viewerState.loaderState !== "ready") {
    throw new Error(`Viewer bootstrap loader did not reach ready state: ${viewerState.loaderState ?? "missing"}.`);
  }
  if (viewerState.qidoRoot !== "/dicom-web" || viewerState.wadoRoot !== "/dicom-web") {
    throw new Error(`Viewer runtime did not use local DICOMweb roots: ${JSON.stringify(viewerState)}`);
  }

  const dicomwebProbe = await evaluateInRenderer(
    cdp,
    `fetch("/dicom-web/studies?StudyInstanceUID=${encodeURIComponent(studyInstanceUid)}", {
      credentials: "include"
    }).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      body: await response.json()
    }))`,
    30000,
  );

  if (!dicomwebProbe.ok) {
    throw new Error(`Viewer-origin local DICOMweb query failed with ${dicomwebProbe.status}.`);
  }
  if (!Array.isArray(dicomwebProbe.body) || dicomwebProbe.body.length === 0) {
    throw new Error("Viewer-origin local DICOMweb query did not return the imported study.");
  }

  const workspaceProbe = await evaluateInRenderer(
    cdp,
    `fetch("/api/studies/${encodeURIComponent(studyInstanceUid)}/workspace", {
      credentials: "include"
    }).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      body: await response.json()
    }))`,
    30000,
  );

  if (!workspaceProbe.ok) {
    throw new Error(`Viewer-origin workspace query failed with ${workspaceProbe.status}.`);
  }

  const renderProbe = await waitForViewerRenderProbe(cdp);

  return {
    href: viewerState.href,
    studyInstanceUID: viewerState.studyInstanceUID,
    viewerKind: viewerState.viewerKind,
    viewerBasePath: viewerState.viewerBasePath,
    qidoRoot: viewerState.qidoRoot,
    wadoRoot: viewerState.wadoRoot,
    configQidoRoot: viewerState.configQidoRoot,
    configWadoRoot: viewerState.configWadoRoot,
    dicomwebStudyCount: dicomwebProbe.body.length,
    workspaceStudyUID: workspaceProbe.body?.worklistRow?.studyInstanceUID ?? null,
    renderProbe,
  };
}

async function waitForViewerRenderProbe(cdp) {
  const startedAt = Date.now();
  let lastProbe = null;

  while (Date.now() - startedAt < 90000) {
    lastProbe = await evaluateInRenderer(cdp, `(${viewerRenderProbeInRenderer.toString()})()`, 30000);
    if (lastProbe.nonBlankCanvasCount > 0) {
      return lastProbe;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `OHIF viewer did not paint a nonblank DICOM canvas. Last render probe: ${JSON.stringify(lastProbe)}`,
  );
}

function viewerRenderProbeInRenderer() {
  const canvases = Array.from(document.querySelectorAll("canvas"));

  const sample2dCanvas = (canvas) => {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || canvas.width <= 0 || canvas.height <= 0) {
      return null;
    }
    const width = Math.min(canvas.width, 48);
    const height = Math.min(canvas.height, 48);
    const data = context.getImageData(0, 0, width, height).data;
    return summarizePixels(data);
  };

  const sampleWebglCanvas = (canvas) => {
    const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!context || canvas.width <= 0 || canvas.height <= 0) {
      return null;
    }
    const width = Math.min(canvas.width, 48);
    const height = Math.min(canvas.height, 48);
    const data = new Uint8Array(width * height * 4);
    context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, data);
    return summarizePixels(data);
  };

  const summarizePixels = (data) => {
    let nonTransparent = 0;
    let nonBlack = 0;
    let maxValue = 0;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index] ?? 0;
      const green = data[index + 1] ?? 0;
      const blue = data[index + 2] ?? 0;
      const alpha = data[index + 3] ?? 0;
      const value = Math.max(red, green, blue);
      if (alpha > 0) {
        nonTransparent += 1;
      }
      if (value > 0) {
        nonBlack += 1;
      }
      maxValue = Math.max(maxValue, value);
    }
    return { nonTransparent, nonBlack, maxValue };
  };

  const samples = canvases.map((canvas) => {
    let sample = null;
    let sampleKind = null;
    let error = null;

    try {
      sample = sample2dCanvas(canvas);
      sampleKind = sample ? "2d" : null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    if (!sample) {
      try {
        sample = sampleWebglCanvas(canvas);
        sampleKind = sample ? "webgl" : null;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }

    return {
      width: canvas.width,
      height: canvas.height,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      sampleKind,
      nonTransparent: sample?.nonTransparent ?? 0,
      nonBlack: sample?.nonBlack ?? 0,
      maxValue: sample?.maxValue ?? 0,
      error,
    };
  });

  return {
    canvasCount: canvases.length,
    nonBlankCanvasCount: samples.filter((sample) => sample.nonBlack > 0).length,
    samples,
  };
}

function localStartNonDicomInspectionInRenderer() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const textMatches = (value, needle) => value.toLowerCase().includes(needle.toLowerCase());

  const waitFor = async (predicate, label, timeoutMs = 60000) => {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const value = predicate();
        if (value) {
          return value;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(150);
    }
    throw new Error(`${label} did not become ready.${lastError ? ` Last error: ${lastError.message}` : ""}`);
  };

  const findButton = (root, label) => Array.from(root.querySelectorAll("button"))
    .find((button) => textMatches(button.innerText, label));

  const triggerPreviewImageLoading = () => {
    for (const image of document.querySelectorAll('[data-testid="local-asset-preview"]')) {
      image.loading = "eager";
      image.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  return (async () => {
    const panel = await waitFor(
      () => {
        const candidate = document.querySelector('[data-testid="local-assets-panel"]');
        return candidate && textMatches(candidate.innerText, "Local NIFTI import") ? candidate : null;
      },
      "local-start non-DICOM local assets panel",
    );

    await waitFor(
      () => textMatches(panel.innerText, "NIFTI volume") &&
        textMatches(panel.innerText, "2 x 3 x 4") &&
        textMatches(panel.innerText, "Paired NIFTI data files") &&
        textMatches(panel.innerText, "NRRD volume") &&
        textMatches(panel.innerText, "Image files"),
      "local-start non-DICOM asset summary",
    );

    triggerPreviewImageLoading();
    await waitFor(
      () => Array.from(document.querySelectorAll('[data-testid="local-asset-preview"]'))
        .some((image) => image.complete && image.naturalWidth > 0),
      "local-start non-DICOM preview image load",
    );

    const coronalButton = await waitFor(
      () => findButton(panel, "coronal"),
      "local-start non-DICOM NIFTI coronal preview control",
    );
    coronalButton.click();
    await waitFor(
      () => Array.from(document.querySelectorAll('[data-testid="local-asset-preview"]'))
        .some((image) => image.src.includes("axis=coronal")),
      "local-start non-DICOM coronal preview image URL",
    );

    const analyzeButton = panel.querySelector('[data-testid="analyze-local-study"]');
    if (!analyzeButton) {
      throw new Error("Analyze action was missing for local-start non-DICOM assets.");
    }
    analyzeButton.click();
    const analysisPanel = await waitFor(
      () => {
        const candidate = document.querySelector('[data-testid="local-analysis-panel"]');
        if (!candidate) {
          return null;
        }
        const text = candidate.innerText;
        return [
          "Voxel count",
          "24",
          "Mean intensity",
          "11.5",
          "paired.hdr",
          "matching .hdr",
          "segmentation.nrrd",
          "NRRD type",
          "uint8",
          "zipped-volume.nii",
          "Image dimensions",
          "1 x 1",
          "Precision",
          "8",
          "2 x 3",
        ].every((needle) => textMatches(text, needle))
          ? candidate
          : null;
      },
      "local-start non-DICOM analysis panel",
    );

    const localRows = Array.from(document.querySelectorAll('[data-testid="worklist-row"]'))
      .filter((row) => textMatches(row.innerText, "Local "))
      .map((row) => row.innerText);
    if (!localRows.some((row) => textMatches(row, "Local NIFTI import"))) {
      throw new Error("Local NIFTI worklist row was missing after non-DICOM local start import.");
    }
    if (localRows.some((row) => textMatches(row, "Local DICOMDIR import"))) {
      throw new Error("Non-DICOM local start import unexpectedly created a DICOM worklist row.");
    }
    if (localRows.some((row) => textMatches(row, "Open viewer"))) {
      throw new Error("Non-DICOM local start import unexpectedly exposed an OHIF viewer action.");
    }

    return {
      currentUrl: window.location.href,
      localRows: localRows.map((row) => row.split("\\n").slice(0, 3).join(" | ")),
      panelSummary: panel.innerText.slice(0, 1000),
      analysisSummary: analysisPanel.innerText.slice(0, 1000),
      previewCount: document.querySelectorAll('[data-testid="local-asset-preview"]').length,
      coronalPreviewUrlSeen: Array.from(document.querySelectorAll('[data-testid="local-asset-preview"]'))
        .some((image) => image.src.includes("axis=coronal")),
    };
  })();
}

function pickerTestPathsForSmokeMode() {
  if (smokeMode === "local-start-nondicom") {
    return [
      "volume.nii",
      "volume.nii.gz",
      "paired.hdr",
      "paired.img",
      "segmentation.nrrd",
      "slice.png",
      "slice.jpeg",
      "slice.tiff",
      "archive.zip",
    ].map((name) => path.join(fixtureRoot, name));
  }

  if (smokeMode !== "picker-files") {
    return [fixtureRoot];
  }

  return [
    "DICOMDIR",
    "SCAN1DCM",
    "volume.nii",
    "volume.nii.gz",
    "paired.hdr",
    "paired.img",
    "segmentation.nrrd",
    "slice.png",
    "slice.jpeg",
    "slice.tiff",
    "archive.zip",
  ].map((name) => path.join(fixtureRoot, name));
}

function readFixturePayloads() {
  return [
    ["DICOMDIR", "ui-smoke/DICOMDIR", "application/dicom"],
    ["SCAN1DCM", "ui-smoke/SCAN1DCM", "application/dicom"],
    ["volume.nii", "ui-smoke/volume.nii", "application/octet-stream"],
    ["volume.nii.gz", "ui-smoke/volume.nii.gz", "application/gzip"],
    ["paired.hdr", "ui-smoke/paired.hdr", "application/octet-stream"],
    ["paired.img", "ui-smoke/paired.img", "application/octet-stream"],
    ["segmentation.nrrd", "ui-smoke/segmentation.nrrd", "application/octet-stream"],
    ["slice.png", "ui-smoke/slice.png", "image/png"],
    ["slice.jpeg", "ui-smoke/slice.jpeg", "image/jpeg"],
    ["slice.tiff", "ui-smoke/slice.tiff", "image/tiff"],
    ["archive.zip", "ui-smoke/archive.zip", "application/zip"],
  ].map(([name, relativePath, type]) => ({
    base64: fs.readFileSync(path.join(fixtureRoot, name)).toString("base64"),
    name,
    relativePath,
    type,
  }));
}

function readDicomFixturePayloads() {
  return readFixturePayloads().filter((payload) => payload.name === "SCAN1DCM");
}

async function waitForDebugTarget(debugPort) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < maxStartupMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        cache: "no-store",
      });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
        if (target) {
          return target;
        }
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Unable to find Electron renderer debug target on ${debugPort}.` +
      `${lastError ? ` Last error: ${lastError.message}` : ""}`,
  );
}

async function waitForRendererCondition(cdp, expression, label, timeoutMs = 60000) {
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastState = await evaluateInRenderer(cdp, `(() => {
        const ok = Boolean(${expression});
        return {
          ok,
          href: window.location.href,
          readyState: document.readyState,
          bodyText: (document.body?.innerText ?? "").slice(0, 1200),
          scripts: Array.from(document.scripts).map((script) => ({
            src: script.src,
            type: script.type,
          })).slice(0, 40),
          aiSmoke: window.__RADSYSX_AI_SMOKE_OPEN_STATE__ ?? null,
          testIds: Array.from(document.querySelectorAll("[data-testid]")).map((node) => node.getAttribute("data-testid")),
        };
      })()`);
      if (lastState.ok) {
        return;
      }
    } catch (error) {
      lastState = { error: error instanceof Error ? error.message : String(error) };
      // The renderer can recreate its execution context during navigation.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`${label} did not become ready. Last renderer state: ${JSON.stringify(lastState)}`);
}

async function evaluateInRenderer(cdp, expression, timeoutMs = 30000) {
  const evaluation = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutMs,
  );

  if (evaluation.exceptionDetails) {
    throw new Error(formatCdpException(evaluation.exceptionDetails));
  }

  return evaluation.result.value;
}

function formatCdpException(exceptionDetails) {
  const description = exceptionDetails.exception?.description;
  if (description) {
    return description;
  }
  return exceptionDetails.text ?? "Renderer evaluation failed.";
}

function uiSmokeInRenderer(fixtures, smokeMode) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const textMatches = (value, needle) => value.toLowerCase().includes(needle.toLowerCase());
  const isPickerMode = smokeMode === "picker-files" ||
    smokeMode === "picker-folder" ||
    smokeMode === "picker-large-folder" ||
    smokeMode === "picker-many-folder";
  const isFilePickerMode = smokeMode === "picker-files";
  const isLargePickerMode = smokeMode === "picker-large-folder";
  const isManyPickerMode = smokeMode === "picker-many-folder";
  const manyDicomCount = 32;
  const expectedAcceptedFiles = 12 + (isLargePickerMode ? 1 : 0) + (isManyPickerMode ? manyDicomCount : 0);
  const expectedDicomInstances = 1 + (isManyPickerMode ? manyDicomCount : 0);

  const waitFor = async (predicate, label, timeoutMs = 60000) => {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const value = predicate();
        if (value) {
          return value;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(150);
    }
    throw new Error(`${label} did not become ready.${lastError ? ` Last error: ${lastError.message}` : ""}`);
  };

  const findButton = (root, label) => Array.from(root.querySelectorAll("button"))
    .find((button) => textMatches(button.innerText, label));

  const rowContaining = (needle) => Array.from(document.querySelectorAll('[data-testid="worklist-row"]'))
    .find((row) => textMatches(row.innerText, needle));

  const clickInspect = async (needle) => {
    const row = await waitFor(() => rowContaining(needle), `${needle} worklist row`);
    const button = row.querySelector('[data-testid="inspect-local-study"]');
    if (!button) {
      throw new Error(`Inspect action was missing for ${needle}.`);
    }
    button.click();
    return waitFor(
      () => {
        const panel = document.querySelector('[data-testid="local-assets-panel"]');
        return panel && textMatches(panel.innerText, needle) ? panel : null;
      },
      `${needle} local asset panel`,
    );
  };

  const clickAnalyzeAndWaitFor = async (needles) => {
    const panel = document.querySelector('[data-testid="local-assets-panel"]');
    const button = panel?.querySelector('[data-testid="analyze-local-study"]');
    if (!button) {
      throw new Error("Analyze action was missing for local assets.");
    }
    button.click();
    return waitFor(
      () => {
        const analysisPanel = document.querySelector('[data-testid="local-analysis-panel"]');
        if (!analysisPanel) {
          return null;
        }
        const text = analysisPanel.innerText;
        return needles.every((needle) => textMatches(text, needle)) ? analysisPanel : null;
      },
      `local analysis panel containing ${needles.join(", ")}`,
    );
  };

  const makeFile = (payload) => {
    const binary = atob(payload.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const file = new File([bytes], payload.name, { type: payload.type });
    Object.defineProperty(file, "radsysxRelativePath", {
      configurable: true,
      value: payload.relativePath,
    });
    return file;
  };

  const dispatchDragDropImport = (importPanel) => {
    const transfer = new DataTransfer();
    for (const payload of fixtures) {
      transfer.items.add(makeFile(payload));
    }

    importPanel.dispatchEvent(new DragEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    importPanel.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  };

  const clickPickerImport = async (importPanel) => {
    if (!window.radsysxDesktop?.importLocalImaging) {
      throw new Error("Desktop direct local imaging import bridge was not exposed to the renderer.");
    }

    const label = isFilePickerMode ? "Import files" : "Import folder";
    const button = await waitFor(
      () => findButton(importPanel, label),
      `desktop ${label} button`,
    );
    button.click();
  };

  const triggerPreviewImageLoading = () => {
    for (const image of document.querySelectorAll('[data-testid="local-asset-preview"]')) {
      image.loading = "eager";
      image.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  return (async () => {
    await waitFor(
      () => window.location.pathname === "/worklist" &&
        document.querySelector('[data-testid="local-import-panel"]'),
      "hydrated worklist local import panel",
    );

    const importPanel = document.querySelector('[data-testid="local-import-panel"]');

    if (isPickerMode) {
      await clickPickerImport(importPanel);
    } else {
      dispatchDragDropImport(importPanel);
    }

    const importMessage = await waitFor(
      () => {
        const message = document.querySelector('[data-testid="local-import-message"]')?.textContent ?? "";
        return message.includes(`Imported ${expectedAcceptedFiles} files into 2 local studies`) ? message : null;
      },
      "local import success message",
    );

    await waitFor(
      () => rowContaining("Local DICOMDIR import") && rowContaining("Local NIFTI import"),
      "imported local worklist rows",
    );

    const dicomPanel = await clickInspect("Local DICOMDIR import");
    await waitFor(
      () => textMatches(dicomPanel.innerText, "DICOM instances") &&
        textMatches(dicomPanel.innerText, String(expectedDicomInstances)) &&
        textMatches(dicomPanel.innerText, "DICOMDIR files"),
      "DICOMDIR asset summary",
    );
    await clickAnalyzeAndWaitFor(["Intensity range", "0 to 3"]);

    const niftiPanel = await clickInspect("Local NIFTI import");
    await waitFor(
      () => textMatches(niftiPanel.innerText, "NIFTI volume") &&
        textMatches(niftiPanel.innerText, "2 x 3 x 4") &&
        (!isLargePickerMode || textMatches(niftiPanel.innerText, "256 x 256 x 128")) &&
        textMatches(niftiPanel.innerText, "Paired NIFTI data files") &&
        textMatches(niftiPanel.innerText, "NRRD volume") &&
        textMatches(niftiPanel.innerText, "Image files"),
      "NIFTI and image asset summary",
    );

    triggerPreviewImageLoading();
    await waitFor(
      () => Array.from(document.querySelectorAll('[data-testid="local-asset-preview"]'))
        .some((image) => image.complete && image.naturalWidth > 0),
      "local preview image load",
    );

    const coronalButton = await waitFor(
      () => findButton(niftiPanel, "coronal"),
      "NIFTI coronal preview control",
    );
    coronalButton.click();
    await waitFor(
      () => Array.from(document.querySelectorAll('[data-testid="local-asset-preview"]'))
        .some((image) => image.src.includes("axis=coronal")),
      "NIFTI coronal preview image URL",
    );

    await clickAnalyzeAndWaitFor([
      "Voxel count",
      "24",
      ...(isLargePickerMode ? ["8388608"] : []),
      "Mean intensity",
      "11.5",
      "paired.hdr",
      "matching .hdr",
      "segmentation.nrrd",
      "NRRD type",
      "uint8",
      "zipped-volume.nii",
      "Image dimensions",
      "1 x 1",
      "Precision",
      "8",
      "2 x 3",
    ]);

    const dicomRow = rowContaining("Local DICOMDIR import");
    const dicomStudyUid = dicomRow?.innerText.match(/Study UID\s+([^\s]+)/)?.[1] ?? null;

    return {
      currentUrl: window.location.href,
      importPath: smokeMode,
      importMessage,
      dicomStudyUid,
      localRows: Array.from(document.querySelectorAll('[data-testid="worklist-row"]'))
        .filter((row) => textMatches(row.innerText, "Local "))
        .map((row) => row.innerText.split("\\n").slice(0, 3).join(" | ")),
      previewCount: document.querySelectorAll('[data-testid="local-asset-preview"]').length,
    };
  })();
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.eventHandlers = new Map();
    this.pending = new Map();

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) {
        if (message.method && this.eventHandlers.has(message.method)) {
          for (const handler of this.eventHandlers.get(message.method)) {
            handler(message.params ?? {});
          }
        }
        return;
      }
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("CDP socket closed before command completed."));
      }
      this.pending.clear();
    });
  }

  static connect(webSocketDebuggerUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketDebuggerUrl);
      socket.addEventListener("open", () => resolve(new CdpClient(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("Unable to open CDP socket.")), {
        once: true,
      });
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(payload);
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  close() {
    this.socket.close();
  }
}

async function stopDesktopRuntime() {
  if (!desktopProcess || desktopProcess.killed) {
    return;
  }

  const child = desktopProcess;
  if (desktopPublicBaseUrl) {
    try {
      await fetch(`${desktopPublicBaseUrl}/_radsysx/desktop/shutdown`, { method: "POST" });
      await waitForExit(child, 10000);
      return;
    } catch {
      // Fall back to external process termination below.
    }
  }

  terminateProcessGroup(child, "SIGTERM");
  await waitForExit(child, 6000);
  if (!child.killed && child.exitCode == null) {
    terminateProcessGroup(child, "SIGKILL");
    await waitForExit(child, 2000);
  }
}

async function waitForExit(child, timeoutMs) {
  await new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function terminateProcessGroup(child, signal) {
  if (!child.pid || child.killed) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // Process already exited.
  }
}

await main();
