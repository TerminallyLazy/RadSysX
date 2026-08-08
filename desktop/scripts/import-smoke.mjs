import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(__filename), "..");
const workspaceRoot = path.resolve(desktopRoot, "..");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radsysx-desktop-import-smoke-"));
const fixtureRoot = path.join(tmpRoot, "fixtures");
const storageRoot = path.join(tmpRoot, "local-imaging-data");
const dbPath = path.join(tmpRoot, "clinical.db");
const maxStartupMs = Number.parseInt(process.env.RADSYSX_IMPORT_SMOKE_STARTUP_MS ?? "120000", 10);

let desktopProcess = null;
let desktopPublicBaseUrl = null;

try {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  generateFixtures(fixtureRoot);
  const publicBaseUrl = await startDesktopRuntime();
  const result = await runImportSmoke(publicBaseUrl);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  await stopDesktopRuntime();
  if (process.env.RADSYSX_KEEP_IMPORT_SMOKE_TMP === "1") {
    console.log(`Kept smoke workspace at ${tmpRoot}`);
  } else {
    fs.rmSync(tmpRoot, { force: true, recursive: true });
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
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

function generateFixtures(outputDir) {
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
    b"# synthetic PHI-free local imaging smoke volume\\n"
    b"type: uint8\\n"
    b"dimension: 3\\n"
    b"sizes: 2 3 4\\n"
    b"encoding: raw\\n"
    b"endian: little\\n\\n"
    + voxels
)
(root / "segmentation.nrrd").write_bytes(nrrd_bytes)
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
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf-8",
    },
  );

  if (python.status !== 0) {
    throw new Error(
      [
        "Unable to generate local imaging smoke fixtures.",
        python.stdout,
        python.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function startDesktopRuntime() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      RADSYSX_DESKTOP_PORT: process.env.RADSYSX_DESKTOP_PORT ?? "37000",
      RADSYSX_DESKTOP_FRONTEND_PORT: process.env.RADSYSX_DESKTOP_FRONTEND_PORT ?? "37010",
      RADSYSX_DESKTOP_BACKEND_PORT: process.env.RADSYSX_DESKTOP_BACKEND_PORT ?? "37080",
      RADSYSX_LOCAL_IMAGING_ENABLED: "true",
      RADSYSX_LOCAL_IMAGING_STORAGE_DIR: storageRoot,
      RADSYSX_CLINICAL_DATABASE_URL: `sqlite:///${asFileUrlPath(dbPath)}`,
      RADSYSX_SESSION_COOKIE_SECURE: "false",
      RADSYSX_DESKTOP_ALLOW_TEST_SHUTDOWN: "1",
    };

    desktopProcess = spawn(npmCommand(), ["run", "dev", "--workspace", "@radsysx/desktop"], {
      cwd: workspaceRoot,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
          resolve(match[1]);
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

async function runImportSmoke(publicBaseUrl) {
  const cookie = await login(publicBaseUrl);
  const importPayload = await importLocalFiles(publicBaseUrl, cookie);
  assert(importPayload.acceptedFiles === 12, `Expected 12 accepted files, got ${importPayload.acceptedFiles}.`);
  assert(importPayload.rejectedFiles === 0, `Expected 0 rejected files, got ${importPayload.rejectedFiles}.`);
  assert(
    importPayload.warnings.some((warning) => warning === "Expanded archive archive.zip into 2 file(s)."),
    "ZIP archive expansion warning was not returned.",
  );

  const worklist = await getJson(`${publicBaseUrl}/api/worklist`, cookie);
  for (const study of importPayload.importedStudies) {
    assert(
      worklist.rows.some((row) => row.studyInstanceUID === study.studyInstanceUID),
      `Imported study ${study.studyInstanceUID} was not present in the worklist.`,
    );
  }

  const summaries = [];
  for (const study of importPayload.importedStudies) {
    summaries.push(await getJson(
      `${publicBaseUrl}/api/local-imaging/studies/${encodeURIComponent(study.studyInstanceUID)}/assets`,
      cookie,
    ));
  }

  const dicomSummary = summaries.find((summary) => summary.formats.includes("dicom"));
  assert(dicomSummary, "DICOM summary was not returned.");
  assert(
    dicomSummary.assets.some((asset) => asset.format === "dicom" && asset.viewerSupported),
    "DICOM asset was not marked viewer-supported.",
  );
  const dicomSearch = await getJson(
    `${publicBaseUrl}/dicom-web/studies?StudyInstanceUID=${encodeURIComponent(dicomSummary.studyInstanceUID)}`,
    cookie,
  );
  assert(Array.isArray(dicomSearch) && dicomSearch.length > 0, "Local DICOMweb search did not return imported DICOM.");

  const niftiSummary = summaries.find((summary) => summary.formats.includes("nifti"));
  assert(niftiSummary, "NIFTI summary was not returned.");
  assert(
    niftiSummary.assets.some((asset) => asset.relativePath.endsWith("volume.nii") && asset.analysisSupported),
    "Plain .nii asset was not analysis-supported.",
  );
  assert(
    niftiSummary.assets.some((asset) => asset.relativePath.endsWith("volume.nii.gz") && asset.analysisSupported),
    "Gzipped .nii asset was not analysis-supported.",
  );
  assert(
    niftiSummary.findings.some((finding) => finding.label === "NIFTI volume" && finding.value.includes("2 x 3 x 4")),
    "NIFTI dimensions were not reported.",
  );
  assert(
    niftiSummary.findings.some((finding) => finding.label === "Paired NIFTI data files" && finding.value === "1"),
    "Paired NIFTI data count was not reported.",
  );
  assert(
    niftiSummary.findings.some((finding) => finding.label === "NRRD volume" && finding.value.includes("2 x 3 x 4")),
    "NRRD dimensions were not reported.",
  );
  assert(
    niftiSummary.findings.some((finding) => finding.label === "Image files" && finding.value === "4"),
    "Fallback image count was not reported.",
  );
  assert(
    niftiSummary.assets.some((asset) => asset.relativePath.endsWith("archive/zipped-volume.nii")),
    "NIFTI asset expanded from ZIP archive was not returned.",
  );
  assert(
    niftiSummary.assets.some((asset) => asset.relativePath.endsWith("archive/zipped-slice.png")),
    "PNG asset expanded from ZIP archive was not returned.",
  );
  const niftiPreviewAsset = niftiSummary.assets.find((asset) => asset.relativePath.endsWith("volume.nii.gz"));
  assert(niftiPreviewAsset?.previewSupported, "NIFTI asset was not marked preview-supported.");
  assert(niftiPreviewAsset?.previewUrl, "NIFTI asset did not include a preview URL.");
  assert(
    niftiPreviewAsset.previewSlices?.axial === 4 &&
      niftiPreviewAsset.previewSlices?.coronal === 3 &&
      niftiPreviewAsset.previewSlices?.sagittal === 2,
    "NIFTI preview slices were not reported.",
  );
  const niftiPreview = await getRaw(resolveLocalUrl(publicBaseUrl, niftiPreviewAsset.previewUrl), cookie);
  assert(
    niftiPreview.contentType.startsWith("image/svg+xml"),
    `NIFTI preview returned ${niftiPreview.contentType}.`,
  );
  assert(niftiPreview.body.includes("<svg"), "NIFTI preview did not return SVG content.");
  assert(niftiPreview.body.includes("NIFTI axial slice 3 preview"), "NIFTI default axial preview was not returned.");
  const coronalPreview = await getRaw(
    resolveLocalUrl(publicBaseUrl, `${niftiPreviewAsset.previewUrl}?axis=coronal&slice=1`),
    cookie,
  );
  assert(
    coronalPreview.body.includes("NIFTI coronal slice 2 preview"),
    "NIFTI coronal preview was not returned.",
  );
  const pairedNiftiPreviewAsset = niftiSummary.assets.find((asset) => asset.relativePath.endsWith("paired.hdr"));
  assert(pairedNiftiPreviewAsset?.previewSupported, "Paired NIFTI header asset was not marked preview-supported.");
  assert(pairedNiftiPreviewAsset?.previewUrl, "Paired NIFTI header asset did not include a preview URL.");
  const pairedNiftiPreview = await getRaw(
    resolveLocalUrl(publicBaseUrl, `${pairedNiftiPreviewAsset.previewUrl}?axis=sagittal&slice=1`),
    cookie,
  );
  assert(
    pairedNiftiPreview.body.includes("NIFTI sagittal slice 2 preview"),
    "Paired NIFTI sagittal preview was not returned.",
  );
  const pairedNiftiDataAsset = niftiSummary.assets.find((asset) => asset.relativePath.endsWith("paired.img"));
  assert(pairedNiftiDataAsset, "Paired NIFTI .img asset was not returned.");
  assert(!pairedNiftiDataAsset.previewSupported, "Paired NIFTI .img asset should not be preview-supported directly.");
  const nrrdAsset = niftiSummary.assets.find((asset) => asset.relativePath.endsWith("segmentation.nrrd"));
  assert(nrrdAsset?.analysisSupported, "NRRD asset was not analysis-supported.");
  assert(!nrrdAsset.previewSupported, "NRRD asset should not be preview-supported yet.");

  const imagePreviewAsset = niftiSummary.assets.find((asset) => asset.format === "png");
  assert(imagePreviewAsset?.previewSupported, "PNG asset was not marked preview-supported.");
  assert(imagePreviewAsset?.previewUrl, "PNG asset did not include a preview URL.");
  const imagePreview = await getRaw(resolveLocalUrl(publicBaseUrl, imagePreviewAsset.previewUrl), cookie);
  assert(
    imagePreview.contentType.startsWith("image/png"),
    `PNG preview returned ${imagePreview.contentType}.`,
  );
  assert(imagePreview.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "PNG preview did not return PNG bytes.");

  const jpegPreviewAsset = niftiSummary.assets.find((asset) => asset.format === "jpeg");
  assert(jpegPreviewAsset?.previewSupported, "JPEG asset was not marked preview-supported.");
  assert(jpegPreviewAsset?.previewUrl, "JPEG asset did not include a preview URL.");
  const jpegPreview = await getRaw(resolveLocalUrl(publicBaseUrl, jpegPreviewAsset.previewUrl), cookie);
  assert(
    jpegPreview.contentType.startsWith("image/jpeg"),
    `JPEG preview returned ${jpegPreview.contentType}.`,
  );
  assert(jpegPreview.buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "JPEG preview did not return JPEG bytes.");

  const tiffPreviewAsset = niftiSummary.assets.find((asset) => asset.format === "tiff");
  assert(tiffPreviewAsset?.previewSupported, "TIFF asset was not marked preview-supported.");
  assert(tiffPreviewAsset?.previewUrl, "TIFF asset did not include a preview URL.");
  const tiffPreview = await getRaw(resolveLocalUrl(publicBaseUrl, tiffPreviewAsset.previewUrl), cookie);
  assert(
    tiffPreview.contentType.startsWith("image/svg+xml"),
    `TIFF preview returned ${tiffPreview.contentType}.`,
  );
  assert(tiffPreview.body.includes("TIFF header preview 2 x 3"), "TIFF header preview was not returned.");

  const dicomAnalysis = await getJson(
    `${publicBaseUrl}/api/local-imaging/studies/${encodeURIComponent(dicomSummary.studyInstanceUID)}/analysis`,
    cookie,
  );
  const dicomAssetAnalysis = dicomAnalysis.analyses.find((analysis) => analysis.format === "dicom");
  assert(dicomAssetAnalysis, "DICOM technical analysis was not returned.");
  assert(
    dicomAssetAnalysis.metrics.some((metric) => metric.label === "Intensity range" && metric.value === "0 to 3"),
    "DICOM intensity range was not analyzed.",
  );

  const niftiAnalysis = await getJson(
    `${publicBaseUrl}/api/local-imaging/studies/${encodeURIComponent(niftiSummary.studyInstanceUID)}/analysis`,
    cookie,
  );
  const niftiAssetAnalysis = niftiAnalysis.analyses.find((analysis) => analysis.format === "nifti");
  assert(niftiAssetAnalysis, "NIFTI technical analysis was not returned.");
  assert(
    niftiAssetAnalysis.metrics.some((metric) => metric.label === "Voxel count" && metric.value === "24"),
    "NIFTI voxel count was not analyzed.",
  );
  assert(
    niftiAssetAnalysis.metrics.some((metric) => metric.label === "Mean intensity" && metric.value === "11.5"),
    "NIFTI mean intensity was not analyzed.",
  );
  const pairedNiftiAssetAnalysis = niftiAnalysis.analyses.find((analysis) => analysis.relativePath.endsWith("paired.hdr"));
  assert(pairedNiftiAssetAnalysis, "Paired NIFTI header technical analysis was not returned.");
  assert(
    pairedNiftiAssetAnalysis.metrics.some((metric) => metric.label === "Voxel count" && metric.value === "24"),
    "Paired NIFTI voxel count was not analyzed.",
  );
  assert(
    pairedNiftiAssetAnalysis.metrics.some((metric) => metric.label === "Mean intensity" && metric.value === "11.5"),
    "Paired NIFTI mean intensity was not analyzed.",
  );
  const pairedNiftiDataAnalysis = niftiAnalysis.analyses.find((analysis) => analysis.relativePath.endsWith("paired.img"));
  assert(pairedNiftiDataAnalysis, "Paired NIFTI data technical analysis row was not returned.");
  assert(
    pairedNiftiDataAnalysis.summary.includes("matching .hdr"),
    "Paired NIFTI data row did not explain matching header analysis.",
  );
  const archiveNiftiAssetAnalysis = niftiAnalysis.analyses.find((analysis) => analysis.relativePath.endsWith("archive/zipped-volume.nii"));
  assert(archiveNiftiAssetAnalysis, "ZIP-expanded NIFTI technical analysis row was not returned.");
  assert(
    archiveNiftiAssetAnalysis.metrics.some((metric) => metric.label === "Voxel count" && metric.value === "24"),
    "ZIP-expanded NIFTI voxel count was not analyzed.",
  );
  const nrrdAssetAnalysis = niftiAnalysis.analyses.find((analysis) => analysis.format === "nrrd");
  assert(nrrdAssetAnalysis, "NRRD technical analysis was not returned.");
  assert(
    nrrdAssetAnalysis.metrics.some((metric) => metric.label === "NRRD type" && metric.value === "uint8"),
    "NRRD type was not analyzed.",
  );
  assert(
    nrrdAssetAnalysis.metrics.some((metric) => metric.label === "Mean intensity" && metric.value === "11.5"),
    "NRRD mean intensity was not analyzed.",
  );
  const imageAssetAnalysis = niftiAnalysis.analyses.find((analysis) => analysis.format === "png");
  assert(imageAssetAnalysis, "PNG technical analysis was not returned.");
  assert(
    imageAssetAnalysis.metrics.some((metric) => metric.label === "Image dimensions" && metric.value === "1 x 1"),
    "PNG dimensions were not analyzed.",
  );
  const jpegAssetAnalysis = niftiAnalysis.analyses.find((analysis) => analysis.format === "jpeg");
  assert(jpegAssetAnalysis, "JPEG technical analysis was not returned.");
  assert(
    jpegAssetAnalysis.metrics.some((metric) => metric.label === "Image dimensions" && metric.value === "1 x 1"),
    "JPEG dimensions were not analyzed.",
  );
  assert(
    jpegAssetAnalysis.metrics.some((metric) => metric.label === "Precision" && metric.value === "8"),
    "JPEG precision was not analyzed.",
  );
  const tiffAssetAnalysis = niftiAnalysis.analyses.find((analysis) => analysis.format === "tiff");
  assert(tiffAssetAnalysis, "TIFF technical analysis was not returned.");
  assert(
    tiffAssetAnalysis.metrics.some((metric) => metric.label === "Image dimensions" && metric.value === "2 x 3"),
    "TIFF dimensions were not analyzed.",
  );

  const launch = await postJson(
    `${publicBaseUrl}/api/imaging/launch`,
    cookie,
    { studyInstanceUID: dicomSummary.studyInstanceUID },
  );
  assert(
    typeof launch.viewerUrl === "string" && launch.viewerUrl.includes("/viewer/?launch="),
    "DICOM study launch did not return an opaque viewer URL.",
  );

  return {
    ok: true,
    publicBaseUrl,
    importedStudies: importPayload.importedStudies.map((study) => ({
      studyInstanceUID: study.studyInstanceUID,
      formats: study.formats,
      fileCount: study.fileCount,
    })),
    summaries: summaries.map((summary) => ({
      studyInstanceUID: summary.studyInstanceUID,
      formats: summary.formats,
      assetCount: summary.assets.length,
      findings: summary.findings,
    })),
    analyses: [dicomAnalysis, niftiAnalysis].map((analysis) => ({
      studyInstanceUID: analysis.studyInstanceUID,
      assetCount: analysis.analyses.length,
      summary: analysis.summary,
    })),
  };
}

async function login(publicBaseUrl) {
  const response = await fetch(`${publicBaseUrl}/api/auth/local-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "demo-radiologist" }),
  });
  const text = await response.text();
  assert(response.ok, `Login failed: ${response.status} ${text}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert(cookie, "Login did not return a session cookie.");
  return cookie;
}

async function importLocalFiles(publicBaseUrl, cookie) {
  const uploads = [
    ["DICOMDIR", "smoke/DICOMDIR", "application/dicom"],
    ["SCAN1DCM", "smoke/SCAN1DCM", "application/dicom"],
    ["volume.nii", "smoke/volume.nii", "application/octet-stream"],
    ["volume.nii.gz", "smoke/volume.nii.gz", "application/gzip"],
    ["paired.hdr", "smoke/paired.hdr", "application/octet-stream"],
    ["paired.img", "smoke/paired.img", "application/octet-stream"],
    ["segmentation.nrrd", "smoke/segmentation.nrrd", "application/octet-stream"],
    ["slice.png", "smoke/slice.png", "image/png"],
    ["slice.jpeg", "smoke/slice.jpeg", "image/jpeg"],
    ["slice.tiff", "smoke/slice.tiff", "image/tiff"],
    ["archive.zip", "smoke/archive.zip", "application/zip"],
  ];

  const form = new FormData();
  form.set("relativePaths", JSON.stringify(uploads.map(([, relativePath]) => relativePath)));
  for (const [filename, relativePath, contentType] of uploads) {
    const payload = fs.readFileSync(path.join(fixtureRoot, filename));
    form.append("files", new File([payload], filename, { type: contentType }), relativePath);
  }

  const response = await fetch(`${publicBaseUrl}/api/local-imaging/import`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  const text = await response.text();
  assert(response.ok, `Import failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function getJson(url, cookie) {
  const response = await fetch(url, { headers: { cookie } });
  const text = await response.text();
  assert(response.ok, `GET ${url} failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function getRaw(url, cookie) {
  const response = await fetch(url, { headers: { cookie } });
  const buffer = Buffer.from(await response.arrayBuffer());
  assert(response.ok, `GET ${url} failed: ${response.status} ${buffer.toString("utf-8")}`);
  return {
    body: buffer.toString("utf-8"),
    buffer,
    contentType: response.headers.get("content-type") ?? "",
  };
}

async function postJson(url, cookie, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  assert(response.ok, `POST ${url} failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

function resolveLocalUrl(publicBaseUrl, maybeRelativeUrl) {
  return /^https?:\/\//i.test(maybeRelativeUrl) ? maybeRelativeUrl : `${publicBaseUrl}${maybeRelativeUrl}`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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
