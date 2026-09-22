import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { publicChildEnvironment } from "../src/environment.mjs";

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
const aiViewerSmoke = smokeMode === "local-start" && process.argv.includes("--ai-live");
const audioPlaybackSmoke = process.argv.includes("--audio-playback");
const credentialsSmoke = process.argv.includes("--credentials");
const realOpenAiAcceptance = process.argv.includes("--real-openai");
const aiProviderId = process.argv.includes("--openai") || realOpenAiAcceptance ? "openai" : "gemini";
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
    if (audioPlaybackSmoke && (smokeMode !== "local-start" || realOpenAiAcceptance)) throw new Error("--audio-playback requires --local-start and is synthetic-only.");
    if (credentialsSmoke && (!aiViewerSmoke || realOpenAiAcceptance)) throw new Error("--credentials requires --local-start --ai-live and is synthetic-only.");
    if (realOpenAiAcceptance && smokeMode !== "viewer-launch") throw new Error("--real-openai requires --viewer-launch and uses a real provider with synthetic data.");
    if (aiProviderId === "openai" && !aiViewerSmoke && !realOpenAiAcceptance) throw new Error("--openai requires --local-start --ai-live.");
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(storageRoot, { recursive: true });

    generateFixtures(fixtureRoot, {
      largePayload: smokeMode === "picker-large-folder",
      manyDicomCount: smokeMode === "picker-many-folder" ? manyDicomCount : 0,
    });
    const runtime = await startDesktopRuntime();
    if (aiViewerSmoke) await compileAdapterProbe();
    if (audioPlaybackSmoke) await compileAudioProbe();
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
    ...(aiViewerSmoke || audioPlaybackSmoke || realOpenAiAcceptance ? publicChildEnvironment(process.env) : process.env),
    RADSYSX_DESKTOP_PORT: String(appPort),
    RADSYSX_DESKTOP_FRONTEND_PORT: String(frontendPort),
    RADSYSX_DESKTOP_BACKEND_PORT: String(backendPort),
    RADSYSX_LOCAL_IMAGING_ENABLED: "true",
    RADSYSX_LOCAL_IMAGING_STORAGE_DIR: storageRoot,
    RADSYSX_CLINICAL_DATABASE_URL: `sqlite:///${asFileUrlPath(dbPath)}`,
    RADSYSX_AI_KEY_STORE_DIR: path.join(fs.realpathSync(tmpRoot), ".ai-secrets"),
    RADSYSX_SESSION_COOKIE_SECURE: "false",
    RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN: "1",
    RADSYSX_DESKTOP_REBUILD_FRONTEND: process.env.RADSYSX_DESKTOP_REBUILD_FRONTEND ?? "1",
    ...(aiViewerSmoke || audioPlaybackSmoke ? {
      RADSYSX_APP_MODE: "pilot", RADSYSX_AI_ENABLED: "true", RADSYSX_GEMINI_API_KEY: "synthetic-unused-key",
      RADSYSX_OPENAI_API_KEY: "synthetic-unused-key",
      RADSYSX_DESKTOP_BACKEND_APP: "backend.clinical.ai_fixture_server:app",
    } : {}),
    ...(realOpenAiAcceptance ? { RADSYSX_APP_MODE: "pilot", RADSYSX_AI_ENABLED: "true", RADSYSX_DESKTOP_BACKEND_APP: "backend.server:app" } : {}),
    ...(pickerSmokeModes.has(smokeMode)
      ? { RADSYSX_DESKTOP_PICKER_TEST_PATHS: JSON.stringify(pickerTestPathsForSmokeMode()) }
      : {}),
  };

  return new Promise((resolve, reject) => {
    desktopProcess = spawn(
      electronCommand(),
      ["--no-sandbox", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(tmpRoot, "profile")}`,
        ...(aiViewerSmoke || audioPlaybackSmoke || realOpenAiAcceptance ? ["--use-fake-device-for-media-stream"] : []), desktopRoot],
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
    const cloudMedia = { audioBytes: 0, audioFrames: 0, audioMarkers: 0, assistantTranscripts: 0, screenFrames: 0 };
    if (realOpenAiAcceptance) {
      const liveSockets = new Set();
      cdp.on("Network.webSocketCreated", event => {
        if (new URL(event.url).pathname.startsWith('/api/ai/sidebar/sessions/')) liveSockets.add(event.requestId);
      });
      cdp.on("Network.webSocketFrameReceived", event => {
        if (!liveSockets.has(event.requestId)) return;
        const { opcode, payloadData } = event.response;
        if (opcode === 2) {
          // Count transient PCM without retaining, printing or writing its payload.
          cloudMedia.audioFrames++;
          cloudMedia.audioBytes += Math.floor(payloadData.length * 3 / 4) - (payloadData.endsWith('==') ? 2 : payloadData.endsWith('=') ? 1 : 0);
        } else if (opcode === 1) {
          const message = JSON.parse(payloadData);
          if (message.kind === 'audio_chunk') cloudMedia.audioMarkers++;
          if (message.kind === 'transcript' && message.role === 'assistant' && message.text) cloudMedia.assistantTranscripts++;
        }
      });
      cdp.on("Network.webSocketFrameSent", event => {
        if (liveSockets.has(event.requestId) && event.response.opcode === 1 && JSON.parse(event.response.payloadData).kind === 'screen') cloudMedia.screenFrames++;
      });
      await cdp.send("Network.enable");
    }
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
      if (credentialsSmoke) await evaluateInRenderer(cdp, `(${exerciseCredentials.toString()})("before")`, 45000);
      let credentialScreenshotPath;
      if (credentialsSmoke && process.env.RADSYSX_KEEP_UI_IMPORT_SMOKE_TMP === "1") {
        await evaluateInRenderer(cdp, `document.querySelector('radsysx-ai-chat-panel [data-action="credentials"]').click()`);
        await waitForRendererCondition(cdp, `!document.querySelector('radsysx-ai-chat-panel [data-action="reload-credentials"]').disabled`, "settled credential settings");
        credentialScreenshotPath = path.join(tmpRoot, "synthetic-api-key-settings.png");
        const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(credentialScreenshotPath, Buffer.from(screenshot.data, "base64"));
        await evaluateInRenderer(cdp, `document.querySelector('radsysx-ai-chat-panel [data-action="close-credentials"]').click()`);
      }
      const aiLiveState = aiViewerSmoke ? await evaluateInRenderer(cdp, `(${exerciseLiveViewer.toString()})(${JSON.stringify(aiProviderId)})`, 45000) : undefined;
      const credentialsState = credentialsSmoke ? await evaluateInRenderer(cdp, `(${exerciseCredentials.toString()})("after")`, 45000) : undefined;
      let adapterState;
      if (aiViewerSmoke) {
        await evaluateInRenderer(cdp, fs.readFileSync(path.join(tmpRoot, "adapter-probe.js"), "utf8"), 30000);
        adapterState = await evaluateInRenderer(cdp, `(${exerciseAdapter.toString()})()`, 45000);
      }
      let audioPlaybackState;
      if (audioPlaybackSmoke) {
        await evaluateInRenderer(cdp, fs.readFileSync(path.join(tmpRoot, "audio-probe.js"), "utf8"), 30000);
        audioPlaybackState = await evaluateInRenderer(cdp, `(${exerciseAudioPlayback.toString()})()`, 60000, true);
      }
      let screenshotPath;
      if (process.env.RADSYSX_KEEP_UI_IMPORT_SMOKE_TMP === "1") {
        screenshotPath = path.join(tmpRoot, "synthetic-viewer-sidebar.png");
        const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
      }
      return {
        ok: true,
        smokeMode,
        publicBaseUrl,
        ...localStartResult,
        ...(screenshotPath ? { screenshotPath } : {}),
        ...(credentialScreenshotPath ? { credentialScreenshotPath } : {}),
        ...(aiLiveState ? { aiLiveState } : {}),
        ...(credentialsState ? { credentialsState } : {}),
        ...(adapterState ? { adapterState } : {}),
        ...(audioPlaybackState ? { audioPlaybackState } : {}),
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
    let liveAcceptance;
    if (realOpenAiAcceptance) {
      await verifyAiChatPanel(cdp);
      liveAcceptance = await evaluateInRenderer(cdp, `(${exerciseRealOpenAiViewer.toString()})()`, 180000);
      liveAcceptance.approvalScreenshotPath = path.join(tmpRoot, 'real-openai-report-approval.png');
      const approvalScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(liveAcceptance.approvalScreenshotPath, Buffer.from(approvalScreenshot.data, 'base64'));
      Object.assign(liveAcceptance, await evaluateInRenderer(cdp, `(${approveRealOpenAiReport.toString()})(${JSON.stringify(liveAcceptance.reportProposalId)})`, 90000));
      if (!cloudMedia.audioBytes || cloudMedia.audioMarkers !== cloudMedia.audioFrames || !cloudMedia.assistantTranscripts || !cloudMedia.screenFrames) throw new Error(`Real OpenAI media evidence incomplete: ${JSON.stringify(cloudMedia)}`);
      liveAcceptance.media = cloudMedia;
      liveAcceptance.screenshotPath = path.join(tmpRoot, 'real-openai-synthetic-viewer.png');
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(liveAcceptance.screenshotPath, Buffer.from(screenshot.data, 'base64'));
    }

    return {
      ok: true,
      smokeMode,
      publicBaseUrl,
      ...result,
      ...(viewerLaunch ? { viewerLaunch } : {}),
      ...(liveAcceptance ? { liveAcceptance } : {}),
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

async function compileAdapterProbe() {
  return compileLiveProbe('ohif', 'adapter-probe.js', '__RadSysXSmokeAdapter');
}

async function compileAudioProbe() {
  return compileLiveProbe('audio', 'audio-probe.js', '__RadSysXSmokeAudio');
}

async function compileLiveProbe(moduleName, filename, library) {
  // Bundle the same compiled module as production solely into this test workspace.
  // The application itself exposes no controller/adapter/audio debug global.
  const webpack = createRequire(path.join(workspaceRoot, "viewer/package.json"))("webpack");
  await new Promise((resolve, reject) => {
    const compiler = webpack({ mode: "production", target: "web", devtool: false,
      entry: path.join(workspaceRoot, `viewer/.cache/live-runtime/${moduleName}.js`),
      output: { path: tmpRoot, filename, library: { name: library, type: "var" } },
    });
    compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors()
      ? reject(error ?? new Error(stats.toString({ errors: true, warnings: false }))) : resolve()));
  });
}

async function exerciseAudioPlayback() {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const audio = new window.__RadSysXSmokeAudio.LiveAudio();
  audio.configure(24000, 24000);
  const overflows = [], receipts = [], sources = [];
  audio.onOverflow = reason => overflows.push(String(reason ?? 'overflow'));
  audio.onPlaybackStopped = items => receipts.push(...items);
  let allocations = 0;
  await audio.prepare();
  const context = audio.context;
  assert(context?.state === 'running', 'The real Electron AudioContext did not start');
  const createBuffer = context.createBuffer.bind(context), createSource = context.createBufferSource.bind(context);
  context.createBuffer = (...args) => { allocations++; return createBuffer(...args); };
  context.createBufferSource = (...args) => {
    const node = createSource(...args), record = { ended: false, stopped: false };
    sources.push(record);
    node.addEventListener('ended', () => { record.ended = true; }, { once: true });
    const stop = node.stop.bind(node);
    node.stop = (...values) => { record.stopped = true; return stop(...values); };
    return node;
  };
  const burst = (seconds, itemId) => {
    const began = performance.now();
    for (let index = 0; index < seconds * 10; index++) audio.play(new ArrayBuffer(4800), { itemId, contentIndex: 0 });
    return performance.now() - began;
  };
  try {
    const fullStart = performance.now();
    const twentySecondBurstMs = burst(20, 'complete-twenty');
    assert(twentySecondBurstMs < 1000, 'Twenty seconds of PCM did not arrive within one second');
    assert(overflows.length === 0, 'A normal twenty-second model burst triggered playback overflow');
    assert(audio.queuedMilliseconds > 19000, 'Normal speech was not buffered completely');
    while (audio.queuedMilliseconds > 0 && performance.now() - fullStart < 25000) await sleep(100);
    await sleep(200);
    const fullElapsedMs = performance.now() - fullStart;
    const fullPosition = audio.playbackPosition().find(item => item.itemId === 'complete-twenty');
    assert(fullElapsedMs >= 19500 && fullElapsedMs < 23000, 'Twenty-second PCM did not play at its normal duration');
    assert(audio.queuedMilliseconds === 0 && sources.every(source => source.ended), 'Natural playback did not finish every real audio source');
    assert(fullPosition?.audioEndMs >= 19900 && fullPosition.audioEndMs <= 20000, 'Completed audible position did not match twenty seconds');
    audio.stopOutput();

    const interruptStart = performance.now(), firstLongSource = sources.length;
    const fortyFiveSecondBurstMs = burst(45, 'interrupt-forty-five');
    assert(fortyFiveSecondBurstMs < 1000, 'Forty-five seconds of PCM did not arrive within one second');
    assert(overflows.length === 0, 'A normal forty-five-second model burst triggered playback overflow');
    const queuedAtArrivalMs = audio.queuedMilliseconds;
    assert(queuedAtArrivalMs > 44000, 'The complete forty-five-second speech burst was not queued');
    await sleep(2200);
    const actualElapsedMs = performance.now() - interruptStart, queuedBeforeStopMs = audio.queuedMilliseconds;
    audio.stopOutput();
    const interrupted = receipts.find(item => item.itemId === 'interrupt-forty-five');
    assert(interrupted?.audioEndMs > 1500 && interrupted.audioEndMs < actualElapsedMs + 100 && Math.abs(interrupted.audioEndMs - actualElapsedMs) < 600, 'Interruption acknowledged queued speech instead of actual audible time');
    assert(queuedBeforeStopMs > 41000 && audio.queuedMilliseconds === 0, 'Interruption did not clear queued speech immediately');
    assert(sources.slice(firstLongSource).every(source => source.ended || source.stopped), 'Interruption left a real audio source running');

    const beforeOversize = allocations;
    audio.play(new ArrayBuffer(61 * 24000 * 2), { itemId: 'reject-sixty-one', contentIndex: 0 });
    assert(allocations === beforeOversize && overflows.length === 1, 'More than sixty seconds must be rejected before AudioBuffer allocation');
    const beforeInclusive = allocations;
    audio.play(new ArrayBuffer(59 * 24000 * 2), { itemId: 'reject-inclusive', contentIndex: 0 });
    assert(allocations === beforeInclusive + 1 && audio.queuedMilliseconds > 58000, 'A bounded fifty-nine-second buffer should be accepted');
    audio.play(new ArrayBuffer(2 * 24000 * 2), { itemId: 'reject-inclusive', contentIndex: 0 });
    assert(allocations === beforeInclusive + 1 && overflows.length === 2, 'The sixty-second limit must include the incoming chunk before allocation');
    assert(audio.queuedMilliseconds === 0 && sources.every(source => source.ended || source.stopped), 'Hard-limit handling left audio sources running');
    return { source: 'Actual compiled LiveAudio in Electron with silent synthetic PCM; no cloud or microphone', pcmSampleRate: 24000,
      outputDeviceContextSampleRate: context.sampleRate, twentySecondBurstMs: Math.round(twentySecondBurstMs),
      fullPlaybackElapsedMs: Math.round(fullElapsedMs), fullAudibleMs: fullPosition.audioEndMs,
      fortyFiveSecondBurstMs: Math.round(fortyFiveSecondBurstMs), queuedAtArrivalMs: Math.round(queuedAtArrivalMs),
      actualElapsedBeforeStopMs: Math.round(actualElapsedMs), acknowledgedAudibleMs: interrupted.audioEndMs,
      unplayedBeforeStopMs: Math.round(queuedBeforeStopMs), normalBurstOverflows: 0, allSourcesStopped: true,
      oversizeRejectedBeforeAllocation: true, incomingChunkIncludedInLimit: true };
  } finally { audio.close(); await context.close(); }
}

async function exerciseAdapter() {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await sleep(50);
    assert(predicate(), message);
  };
  const managers = window.__RADSYSX_OHIF_MANAGERS__;
  const adapter = new window.__RadSysXSmokeAdapter.OHIFAdapter();
  adapter.bind(managers);
  const services = managers.servicesManager.services;
  const viewport = () => services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
  const close = (a, b) => Math.abs(a - b) < 0.1;
  const results = [];
  await adapter.execute('viewer_set_view', { zoom: 2, panX: 25, panY: -15, rotation: 90, invert: true, flipHorizontal: true, flipVertical: true });
  let state = adapter.context().state;
  assert(close(state.zoom, 2) && close(state.panX, 25) && close(state.panY, -15) && close(state.rotation, 90) && state.invert && state.flipHorizontal && state.flipVertical, 'Actual zoom/pan/rotation/flip/invert did not match: ' + JSON.stringify(state));
  results.push('zoom', 'pan', 'rotation', 'flip', 'invert');
  await adapter.execute('viewer_set_view', { reset: true });
  state = adapter.context().state;
  assert(close(state.zoom, 1) && close(state.panX, 0) && close(state.panY, 0) && close(state.rotation, 0) && !state.invert && !state.flipHorizontal && !state.flipVertical, 'Actual viewport reset failed: ' + JSON.stringify(state));
  results.push('reset');
  await adapter.execute('viewer_jump_to_slice', { index: 0 });
  assert(adapter.context().state.index === 0, 'Synthetic single slice jump failed');
  results.push('slice');
  await adapter.execute('viewer_set_tool', { tool: 'Length' });
  const group = services.toolGroupService.getToolGroupForViewport(viewport().id);
  assert(group.getActivePrimaryMouseButtonTool() === 'Length', 'Actual Length tool did not become active');
  await adapter.execute('viewer_set_tool', { tool: 'WindowLevel' });
  results.push('active-tool');
  await adapter.execute('viewer_set_layout', { rows: 1, columns: 2 });
  await waitFor(() => services.viewportGridService.getState().layout.numCols === 2, 'Actual two-column layout failed');
  await adapter.execute('viewer_set_layout', { rows: 1, columns: 1 });
  await waitFor(() => services.viewportGridService.getState().layout.numCols === 1 && viewport()?.element?.isConnected && viewport()?.getImageIds?.()?.length === 1, 'Actual layout restore failed');
  results.push('layout-restore');
  for (const type of ['Length', 'RectangleROI']) {
    const previous = services.measurementService.getMeasurements().length;
    await adapter.execute('viewer_measurement', { operation: 'create', type, points: [[0.25, 0.25], [0.7, 0.7]], label: 'Synthetic ' + type });
    await waitFor(() => services.measurementService.getMeasurements().length === previous + 1, type + ' registration failed');
    let attachment = adapter.attachments().find(item => item.summary.type === type);
    assert(attachment, type + ' attachment unavailable');
    if (type === 'Length') {
      await adapter.execute('viewer_undo', {});
      await waitFor(() => services.measurementService.getMeasurements().length === previous, 'Measurement undo failed');
      await adapter.execute('viewer_redo', {});
      await waitFor(() => services.measurementService.getMeasurements().length === previous + 1, 'Measurement redo failed');
      attachment = adapter.attachments().find(item => item.summary.type === type);
      results.push('measurement-undo-redo');
    }
    await adapter.execute('viewer_measurement', { operation: 'update', measurementId: attachment.id, label: 'Updated synthetic ' + type });
    assert(services.measurementService.getMeasurements().some(item => item.label === 'Updated synthetic ' + type), type + ' label update failed');
    await adapter.execute('viewer_measurement', { operation: 'jump', measurementId: attachment.id });
    await adapter.execute('viewer_measurement', { operation: 'delete', measurementId: attachment.id });
    await waitFor(() => services.measurementService.getMeasurements().length === previous, type + ' delete failed');
    results.push(type + '-create-update-jump-delete');
  }
  await adapter.execute('report_draft', { findings: 'Synthetic draft', impression: 'Synthetic impression' });
  assert(adapter.draftReport?.findings === 'Synthetic draft', 'Local report draft failed');
  await adapter.execute('viewer_undo', {});
  assert(!adapter.draftReport, 'Local draft undo failed');
  await adapter.execute('viewer_redo', {});
  assert(adapter.draftReport?.findings === 'Synthetic draft', 'Local draft redo failed');
  results.push('draft-undo-redo');
  const previous = services.measurementService.getMeasurements().length;
  await adapter.execute('viewer_measurement', { operation: 'create', type: 'Length', points: [[0.2, 0.3], [0.8, 0.6]], label: 'Synthetic mixed history' });
  await waitFor(() => services.measurementService.getMeasurements().length === previous + 1, 'Mixed-history annotation creation failed');
  await adapter.execute('viewer_undo', {});
  await waitFor(() => services.measurementService.getMeasurements().length === previous, 'Mixed-history undo must remove the latest annotation first');
  assert(adapter.draftReport?.findings === 'Synthetic draft', 'Undoing the latest annotation changed the earlier draft');
  await adapter.execute('viewer_undo', {}); assert(!adapter.draftReport, 'Second mixed-history undo did not remove draft');
  await adapter.execute('viewer_redo', {}); assert(adapter.draftReport?.findings === 'Synthetic draft', 'First mixed-history redo did not restore draft');
  await adapter.execute('viewer_redo', {});
  await waitFor(() => services.measurementService.getMeasurements().length === previous + 1, 'Second mixed-history redo did not restore annotation');
  await adapter.execute('viewer_measurement', { operation: 'delete', measurementId: adapter.attachments().find(item => item.summary.type === 'Length').id });
  await waitFor(() => services.measurementService.getMeasurements().length === previous, 'Mixed-history cleanup failed');
  results.push('draft-annotation-shared-history');
  await adapter.execute('viewer_set_window_level', { windowWidth: 400, windowCenter: 40 });
  return { actions: results, measurementsRemaining: services.measurementService.getMeasurements().length, segmentation: 'No segmentation fixture; not verified' };
}

async function exerciseRealOpenAiViewer() {
  const panel = document.querySelector('radsysx-ai-chat-panel');
  const button = action => panel.querySelector(`[data-action="${action}"]`);
  const status = () => panel.querySelector('[data-role="status"]')?.textContent;
  const waitFor = async (predicate, reason, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    do { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 150)); } while (Date.now() < deadline);
    throw new Error(`${reason}: ${status()}`);
  };
  if (panel.querySelector('.radsysx-ai-mention-menu').dataset.open === 'true') button('toggle-mention').click();
  const provider = panel.querySelector('[data-role="provider"]');
  if (!provider.options.length) {
    if (button('connect').textContent !== 'Retry setup') throw new Error('Provider setup unavailable');
    button('connect').click(); await waitFor(() => provider.options.length && !provider.disabled, 'Provider setup retry failed');
  }
  provider.value = 'openai'; provider.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => provider.value === 'openai' && panel.state.backendStatus === 'disconnected', 'OpenAI selection did not become available');
  const attestation = panel.querySelector('#radsysx-live-attestation');
  if (attestation.value) throw new Error('OpenAI selection did not reset data confirmation');
  attestation.value = 'synthetic'; attestation.dispatchEvent(new Event('change', { bubbles: true }));
  button('connect').click();
  await waitFor(() => panel.state.backendStatus === 'ready', 'Real OpenAI session did not become ready');
  const sessionId = panel.state.backendSessionId;
  const history = async () => (await fetch(`/api/ai/sidebar/sessions/${sessionId}`, { credentials: 'include' })).json();
  const allocation = await history();
  if (allocation.session.providerId !== 'openai' || allocation.session.modelId !== 'gpt-realtime-2.1-mini' ||
      allocation.session.inputSampleRate !== 24000 || allocation.session.outputSampleRate !== 24000) throw new Error('Unexpected real OpenAI session profile');
  try {
    button('share').click();
    await waitFor(() => button('share').getAttribute('aria-pressed') === 'true', 'Synthetic active image sharing did not start');
    await new Promise(resolve => setTimeout(resolve, 1400));
    const services = window.__RADSYSX_OHIF_MANAGERS__.servicesManager.services;
    const viewport = () => services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
    const beforeZoom = viewport().getZoom();
    const expectedZoom = Math.abs(beforeZoom - 1.5) > 0.1 ? 1.5 : 1.25;
    const sendText = text => {
      const input = panel.querySelector('textarea'); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
      panel.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
    sendText(`This is a synthetic integration test, not a clinical interpretation. Use viewer_set_view to set the active viewport zoom to exactly ${expectedZoom}. After the tool completes, say only "Zoom test complete." Do not research or change any other setting.`);
    const zoomHistory = await waitFor(async () => {
      const saved = await history();
      return saved.tools.some(tool => tool.name === 'viewer_set_view' && tool.status === 'completed' && tool.args.zoom === expectedZoom) &&
        saved.events.some(event => event.kind === 'transcript' && event.role === 'assistant' && event.text) &&
        saved.events.at(-1)?.kind === 'interaction' && saved.events.at(-1)?.status === 'IDLE' ? saved : null;
    }, 'Real model did not complete the zoom tool and spoken transcript');
    const afterZoom = viewport().getZoom();
    if (Math.abs(afterZoom - expectedZoom) > 0.01 || Math.abs(afterZoom - beforeZoom) < 0.05) throw new Error('Actual OHIF zoom did not change as requested');
    sendText('Invoke the report_save tool now for this synthetic imported study, with findings exactly "Synthetic integration test only" and impression exactly "Synthetic integration test only". This tool opens the app\'s mandatory approval card; it cannot persist anything until I click Approve. I want that approval card now, not just report_draft. Do not research. Keep your spoken response to "Ready for approval."');
    const proposal = await waitFor(async () => {
      const saved = await history();
      return saved.tools.find(tool => tool.name === 'report_save' && tool.status === 'awaiting_approval');
    }, 'Real model did not propose a report save for review');
    if (proposal.args.findings !== 'Synthetic integration test only' || proposal.args.impression !== 'Synthetic integration test only') throw new Error('Report proposal did not match the authorized exact synthetic text');
    await waitFor(() => panel.querySelector(`[data-action="approve"][data-id="${CSS.escape(proposal.toolCallId)}"]`), 'Report review button did not render');
    panel.querySelector(`[data-action="approve"][data-id="${CSS.escape(proposal.toolCallId)}"]`).scrollIntoView({ block: 'center' });
    return { provider: 'openai', modelId: allocation.session.modelId, source: 'real OpenAI API through normal backend.server', sessionReady: true,
      inputSampleRate: allocation.session.inputSampleRate, outputSampleRate: allocation.session.outputSampleRate,
      beforeZoom, afterZoom, zoomToolCompleted: true, reportProposalId: proposal.toolCallId, reportProposal: proposal.args,
      assistantTranscript: zoomHistory.events.filter(event => event.kind === 'transcript' && event.role === 'assistant').map(event => event.text).join(''),
      microphone: 'Not activated; no physical microphone used' };
  } catch (error) { button('end').click(); throw error; }
}

async function approveRealOpenAiReport(toolCallId) {
  const panel = document.querySelector('radsysx-ai-chat-panel');
  const sessionId = panel.state.backendSessionId;
  const history = async () => (await fetch(`/api/ai/sidebar/sessions/${sessionId}`, { credentials: 'include' })).json();
  try {
    const proposal = (await history()).tools.find(tool => tool.toolCallId === toolCallId);
    if (proposal?.name !== 'report_save' || proposal.status !== 'awaiting_approval' ||
        proposal.args.findings !== 'Synthetic integration test only' || proposal.args.impression !== 'Synthetic integration test only') throw new Error('Review proposal changed before approval');
    const approve = panel.querySelector(`[data-action="approve"][data-id="${CSS.escape(toolCallId)}"]`);
    if (!approve || approve.disabled || !approve.getBoundingClientRect().height) throw new Error('Exact proposal approval control is not visible');
    approve.click();
    const deadline = Date.now() + 45000;
    let receipt;
    do {
      receipt = (await history()).tools.find(tool => tool.toolCallId === toolCallId);
      if (receipt?.status === 'completed') break;
      if (['failed', 'denied', 'cancelled'].includes(receipt?.status)) throw new Error(`Approved report save ended as ${receipt.status}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    if (receipt?.status !== 'completed' || receipt.result?.status !== 'draft_saved') throw new Error('Approved report save did not return a saved-draft receipt');
    const studyUid = window.__RADSYSX_LAUNCH__.context.studyInstanceUID;
    const workspace = await (await fetch(`/api/studies/${encodeURIComponent(studyUid)}/workspace`, { credentials: 'include' })).json();
    const report = workspace.reports.find(item => item.reportId === receipt.result.reportId);
    if (!report || report.findingsSummary !== 'Synthetic integration test only' || report.impression !== 'Synthetic integration test only' || report.status !== 'draft') throw new Error('Backend workspace did not contain the exact approved synthetic draft');
    return { reportApprovedThroughVisibleButton: true, reportSaved: true, reportStatus: report.status, reportId: report.reportId };
  } finally {
    const share = panel.querySelector('[data-action="share"]'); if (share.getAttribute('aria-pressed') === 'true') share.click();
    panel.querySelector('[data-action="end"]').click();
    const deadline = Date.now() + 10000;
    while (panel.state.backendStatus !== 'disconnected' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (panel.state.backendStatus !== 'disconnected') throw new Error('Real OpenAI session did not end cleanly');
  }
}

async function exerciseLiveViewer(providerId) {
  const panel = document.querySelector('radsysx-ai-chat-panel');
  const button = action => panel.querySelector(`[data-action="${action}"]`);
  if (panel.querySelector('.radsysx-ai-mention-menu').dataset.open === 'true') button('toggle-mention').click();
  const layout = () => {
    const rect = selector => panel.querySelector(selector).getBoundingClientRect();
    const setup = rect('[data-role="setup"]'), controls = rect('[data-role="session-controls"]');
    const status = rect('[data-role="status"]');
    const conversation = rect('[data-role="conversation"]'), composer = rect('.radsysx-ai-composer'), shell = rect('.radsysx-live-shell');
    const lastControlBottom = Math.max(setup.bottom, controls.bottom, status.bottom);
    if (lastControlBottom > conversation.top + 2 || conversation.bottom > composer.top + 2 ||
        composer.bottom > Math.min(innerHeight, shell.bottom) + 2 || composer.top < shell.top || composer.width < 150) {
      throw new Error('Live sidebar controls overlap or overflow');
    }
    return { shellWidth: Math.round(shell.width), shellHeight: Math.round(shell.height), conversationHeight: Math.round(conversation.height), composerHeight: Math.round(composer.height) };
  };
  const waitFor = async (predicate, reason) => {
    const deadline = Date.now() + 18000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (!predicate()) throw new Error(`${reason}: ${panel.querySelector('[data-role="status"]')?.textContent}`);
  };
  const media = async () => {
    const response = await fetch('/api/ai/_fixture/media', { credentials: 'include' });
    if (!response.ok) throw new Error('Synthetic media counters unavailable');
    return response.json();
  };
  const waitMedia = async (predicate, reason) => {
    const deadline = Date.now() + 10000;
    let counters;
    do {
      counters = await media();
      if (predicate(counters)) return counters;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error(`${reason}: ${JSON.stringify(counters)}`);
  };
  const expectedRate = providerId === 'openai' ? 24000 : 16000;
  const expectedModel = providerId === 'openai' ? 'gpt-realtime-2.1-mini' : 'gemini-3.8-live-extended-thinking';
  const expectedPacketBytes = expectedRate / 50 * 2;
  const capabilities = await (await fetch('/api/ai/sidebar/capabilities', { credentials: 'include' })).json();
  const profile = capabilities.providers?.find(item => item.id === providerId);
  if (!profile || profile.availability !== 'configured' || profile.modelId !== expectedModel ||
      profile.inputSampleRate !== expectedRate || profile.outputSampleRate !== 24000 || !profile.screen || !profile.tools) {
    throw new Error('Synthetic provider profile did not match the selected audio/action contract');
  }
  const providerSelect = panel.querySelector('[data-role="provider"]');
  if (providerSelect && !providerSelect.options.length) {
    if (button('connect').textContent !== 'Retry setup') throw new Error('Initial setup failure did not expose an actionable retry');
    button('connect').click();
    await waitFor(() => providerSelect.options.length > 0 && !providerSelect.disabled, 'Provider setup retry did not recover after local authentication');
    if (panel.state.backendSessionId) throw new Error('Retrying provider setup unexpectedly allocated a conversation');
  }
  if (!providerSelect || providerSelect.disabled || !Array.from(providerSelect.options).some(option => option.value === providerId)) throw new Error(`Provider dropdown unavailable: ${JSON.stringify({ present: Boolean(providerSelect), disabled: providerSelect?.disabled, values: providerSelect ? Array.from(providerSelect.options).map(option => option.value) : [], status: panel.state.backendStatus, message: panel.querySelector('[data-role="status"]')?.textContent })}`);
  providerSelect.value = providerId; providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => providerSelect.value === providerId && panel.state.backendStatus === 'disconnected' &&
    panel.querySelector('[data-role="disclosure"]').textContent.includes(profile.label), 'Provider selection did not update the sidebar');
  const select = panel.querySelector('#radsysx-live-attestation');
  if (select.value !== '') throw new Error('Provider selection did not require fresh data confirmation');
  select.value = 'synthetic'; select.dispatchEvent(new Event('change', { bubbles: true }));
  button('connect').click();
  await waitFor(() => panel.state.backendStatus === 'ready', 'Synthetic provider did not connect through sidebar');
  const connectedLayout = layout();
  const sessionId = panel.state.backendSessionId;
  const allocation = await (await fetch(`/api/ai/sidebar/sessions/${sessionId}`, { credentials: 'include' })).json();
  if (allocation.session.providerId !== providerId || allocation.session.modelId !== expectedModel ||
      allocation.session.inputSampleRate !== expectedRate || allocation.session.outputSampleRate !== 24000) {
    throw new Error('Live session did not preserve the selected provider/model/audio profile');
  }
  const beforeMicrophone = await media();
  if (beforeMicrophone.audioBytes !== 0) throw new Error('Microphone sent bytes before explicit activation');
  button('voice').click();
  await waitFor(() => button('voice').getAttribute('aria-pressed') === 'true', 'Fake microphone did not start through sidebar');
  const firstAudio = await waitMedia(value => value.audioFrames >= 5, 'Actual AudioWorklet PCM did not reach the provider fixture');
  if (firstAudio.audioMimeTypes.join() !== `audio/pcm;rate=${expectedRate}` || firstAudio.audioFrameSizes.join() !== String(expectedPacketBytes)) throw new Error(`Microphone input was not 20 ms mono PCM16 at ${expectedRate} Hz`);
  button('voice').click();
  await waitFor(() => button('voice').getAttribute('aria-pressed') === 'false', 'Mute did not stop the sidebar microphone');
  await waitMedia(value => value.audioEnds > beforeMicrophone.audioEnds, 'Mute did not send audio_stream_end');
  await new Promise(resolve => setTimeout(resolve, 200));
  const mutedAudio = await media();
  await new Promise(resolve => setTimeout(resolve, 500));
  if ((await media()).audioBytes !== mutedAudio.audioBytes) throw new Error('Microphone PCM continued after mute');
  button('voice').click();
  await waitMedia(value => value.audioBytes >= mutedAudio.audioBytes + expectedPacketBytes * 5, 'Fake microphone did not restart after mute');
  button('share').click();
  await waitFor(() => button('share').getAttribute('aria-pressed') === 'true', 'Actual selected OHIF image could not be shared');
  await new Promise(resolve => setTimeout(resolve, 1200));
  await waitMedia(value => value.videoFrames > 0, 'Selected OHIF capture did not reach provider fixture');
  await waitFor(() => panel.querySelector('[data-role="status"]').textContent.includes('image sharing on · image sent'), 'Backend image receipt did not update the visible sharing status');
  const captureScope = panel.querySelector('[data-role="capture-scope"]')?.textContent;
  if (!captureScope?.includes('Active image only') || !captureScope.includes('Image 1 of 1')) throw new Error('The selected-image sharing scope was not visible');
  const textarea = panel.querySelector('textarea');
  textarea.value = 'Adjust the synthetic image window'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
  panel.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => panel.textContent.includes('Synthetic viewer action completed.'), 'Synthetic async action did not return to conversation');
  const services = window.__RADSYSX_OHIF_MANAGERS__.servicesManager.services;
  const viewport = services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
  const range = viewport.getProperties().voiRange;
  // DICOM LINEAR VOI follows Cornerstone's inclusive-pixel window convention.
  const windowWidth = Math.abs(range.upper - range.lower) + 1;
  const windowCenter = (range.upper + range.lower + 1) / 2;
  if (Math.abs(windowWidth - 400) > 0.1 || Math.abs(windowCenter - 40) > 0.1) throw new Error('Real OHIF window/level did not change');
  const history = await (await fetch(`/api/ai/sidebar/sessions/${sessionId}`, { credentials: 'include' })).json();
  if (!history.tools.some(tool => tool.name === 'viewer_set_window_level' && tool.status === 'completed')) throw new Error('Actual viewer action was not recorded as completed');
  if (button('share').getAttribute('aria-pressed') !== 'true') throw new Error('Image sharing stopped unexpectedly');
  button('share').click();
  await waitFor(() => button('share').getAttribute('aria-pressed') === 'false', 'Image sharing did not stop');
  await waitFor(() => panel.querySelector('[data-role="status"]').textContent.includes('image sharing off'), 'Visible sharing status did not clear after stop');
  button('end').click();
  await waitFor(() => panel.state.backendStatus === 'disconnected', 'Live session did not end');
  await waitMedia(value => value.activeProviders === 0, 'Session end did not close the provider fixture');
  await new Promise(resolve => setTimeout(resolve, 200));
  const endedAudio = await media();
  await new Promise(resolve => setTimeout(resolve, 500));
  if ((await media()).audioBytes !== endedAudio.audioBytes || button('voice').getAttribute('aria-pressed') !== 'false') throw new Error('Microphone PCM continued after session end');
  const endedLayout = layout();
  if (panel.querySelector('[data-role="interaction"]').textContent !== '' || !panel.querySelector('[data-role="session-controls"]').hidden) throw new Error('Ended session retained a stale working indicator');
  return { provider: providerId, modelId: expectedModel, source: 'synthetic fixture (no cloud call)',
    inputSampleRate: expectedRate, outputSampleRate: allocation.session.outputSampleRate, windowWidth, windowCenter,
    completedTools: history.tools.filter(tool => tool.status === 'completed').length, sharingStopped: true, sessionEnded: true, captureScope, imageReceiptVisible: true, connectedLayout, endedLayout,
    microphone: { source: 'Chromium fake device through actual AudioWorklet', audioBytes: endedAudio.audioBytes, audioFrames: endedAudio.audioFrames,
      audioMimeTypes: endedAudio.audioMimeTypes, audioFrameSizes: endedAudio.audioFrameSizes, audioEnds: endedAudio.audioEnds, stoppedAfterMute: true, stoppedAfterEnd: true } };
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
    `["disconnected", "unavailable"].includes(document.querySelector("radsysx-ai-chat-panel")?.state?.backendStatus)`,
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
      const mediaControls = panel?.querySelector("[data-role='session-controls']");
      const sendButton = panel?.querySelector("button[type='submit']");
      mentionButton?.click();
      return {
        aiPanelPresent: Boolean(panel),
        composerPresent: Boolean(textarea),
        mentionButtonPresent: Boolean(mentionButton),
        voiceButtonPresent: Boolean(voiceButton),
        voiceDisabled: voiceButton?.disabled === true,
        mediaControlsPresent: Boolean(mediaControls),
        mediaControlsHidden: mediaControls?.hidden === true,
        sendButtonPresent: Boolean(sendButton),
        connectButtonPresent: Boolean(panel?.querySelector("[data-action='connect']")),
        attestationRequired: panel?.querySelector("#radsysx-live-attestation")?.value === "",
        sharingDisabled: panel?.querySelector("[data-action='share']")?.disabled === true,
        backendStatus: panel?.state?.backendStatus ?? null,
        backendSessionPresent: Boolean(panel?.state?.backendSessionId),
        mentionMenuOpen: panel?.querySelector(".radsysx-ai-mention-menu")?.getAttribute("data-open") === "true",
        attachmentCount: panel?.querySelectorAll("[data-attachment-kind]").length ?? 0,
        attachmentEmptyState: Boolean(panel?.querySelector(".radsysx-ai-mention-menu .radsysx-live-empty"))
      };
    })()`,
    30000,
  );

  if (
    !chatState.aiPanelPresent ||
    !chatState.composerPresent ||
    !chatState.mentionButtonPresent ||
    !chatState.voiceButtonPresent ||
    !chatState.mediaControlsPresent ||
    !chatState.mediaControlsHidden ||
    !chatState.sendButtonPresent ||
    !["disconnected", "unavailable"].includes(chatState.backendStatus) ||
    chatState.backendSessionPresent ||
    !chatState.connectButtonPresent ||
    !chatState.attestationRequired ||
    !chatState.voiceDisabled ||
    !chatState.sharingDisabled ||
    !chatState.mentionMenuOpen ||
    chatState.attachmentCount !== 0 ||
    !chatState.attachmentEmptyState
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
    // Sample the whole image, not the top-left corner (which may be a black
    // DICOM pixel or letterbox margin on the software canvas renderer).
    const probe = document.createElement("canvas");
    probe.width = width;
    probe.height = height;
    const probeContext = probe.getContext("2d", { willReadFrequently: true });
    probeContext.drawImage(canvas, 0, 0, width, height);
    return summarizePixels(probeContext.getImageData(0, 0, width, height).data);
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

async function evaluateInRenderer(cdp, expression, timeoutMs = 30000, userGesture = false) {
  const evaluation = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
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

// Credentials are deliberately synthetic and used only with the guarded fake provider.
async function exerciseCredentials(stage) {
  const panel = document.querySelector('radsysx-ai-chat-panel');
  const button = action => panel.querySelector(`[data-action="${action}"]`);
  const settings = panel.querySelector('[data-role="credentials"]');
  const input = id => settings.querySelector(`[data-key-provider="${id}"]`);
  const form = id => settings.querySelector(`[data-credential-provider="${id}"]`);
  const assert = (value, reason) => { if (!value) throw new Error(reason); };
  const waitFor = async (predicate, reason) => {
    const deadline = Date.now() + 12000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert(predicate(), reason);
  };
  const fill = (id, suffix = '') => {
    input(id).value = `synthetic-settings-smoke-unused-${id}${suffix}`;
    input(id).dispatchEvent(new Event('input', { bubbles: true }));
  };
  const status = async () => {
    const response = await fetch('/api/ai/sidebar/credentials', { credentials: 'include' });
    assert(response.ok, 'Credential status endpoint unavailable');
    const result = await response.json();
    assert(!JSON.stringify(result).includes('synthetic-settings-smoke-unused'), 'Credential status exposed entered secret');
    return result;
  };
  const submit = async id => {
    form(id).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    assert(input('gemini').value === '' && input('openai').value === '', 'Submission did not clear all transient password inputs immediately');
    await waitFor(() => settings.querySelector('[data-role="credential-message"]').textContent.startsWith('Key saved.'), 'Synthetic key did not save through UI');
    assert((await status()).providers.find(provider => provider.id === id)?.source === 'saved', 'Saved status did not match backend');
  };
  if (stage === 'before') {
    assert(!button('credentials').disabled && button('credentials').getBoundingClientRect().height > 0, 'API keys affordance unavailable before connection');
    button('credentials').click();
    await waitFor(() => !settings.hidden && !input('gemini').disabled && !input('openai').disabled, 'Secure key settings did not load');
    assert(input('gemini').type === 'password' && input('openai').type === 'password', 'Key entry is not masked');
    assert(!input('gemini').value && !input('openai').value, 'Stored keys were prefilled');
    fill('gemini'); const original = input('gemini');
    button('reload-credentials').click();
    await waitFor(() => !button('reload-credentials').disabled, 'Credential status refresh did not finish');
    assert(input('gemini') === original && input('gemini').value.length > 0, 'A status render replaced or cleared the edited password');
    await submit('gemini'); fill('openai'); await submit('openai');
    fill('gemini', '-discard'); button('close-credentials').click();
    assert(settings.hidden && !input('gemini').value && !input('openai').value, 'Closing settings retained key entry');
    assert(panel.querySelector('#radsysx-live-attestation').value === '', 'Saving keys did not clear attestation');
    return { savedBothProviders: true, stablePasswordInput: true };
  }
  const select = panel.querySelector('#radsysx-live-attestation');
  select.value = 'synthetic'; select.dispatchEvent(new Event('change', { bubbles: true })); button('connect').click();
  await waitFor(() => panel.state.backendStatus === 'ready', 'Synthetic session did not reconnect before key replacement');
  const sessionId = panel.state.backendSessionId;
  button('credentials').click(); await waitFor(() => !settings.hidden && !input('openai').disabled, 'Replacement settings did not load');
  fill('openai', '-replacement'); await submit('openai');
  assert(panel.state.backendStatus === 'disconnected' && !panel.state.backendSessionId, 'Key replacement retained the active session');
  assert(select.value === '' && button('voice').disabled && button('share').disabled, 'Replacement retained attestation or enabled media');
  const previous = await (await fetch(`/api/ai/sidebar/sessions/${sessionId}`, { credentials: 'include' })).json();
  assert(previous.session.status === 'closed', 'Key replacement did not close the backend session');
  for (const id of ['gemini', 'openai']) {
    assert(settings.querySelector(`[data-role="credential-fallback-${id}"]`).hidden === false, 'Environment fallback was not disclosed before removal');
    form(id).querySelector('[data-action="remove-key"]').click();
    await waitFor(() => settings.querySelector('[data-role="credential-message"]').textContent.includes('app-configured key will be used'), 'Removal did not disclose restored environment key');
    assert((await status()).providers.find(provider => provider.id === id)?.source === 'environment', 'Saved key removal did not restore environment fallback');
  }
  assert(!input('gemini').value && !input('openai').value, 'Credential operation left key entry in DOM');
  button('close-credentials').click();
  return { savedBothProviders: true, stablePasswordInput: true, maskedInputs: true, inputsCleared: true, replacedDuringActiveSession: true, sessionClosed: true, attestationCleared: true, removedBothSavedKeys: true, environmentFallbackDisclosed: true, providerAccessVerified: false, cloudCalls: false };
}
