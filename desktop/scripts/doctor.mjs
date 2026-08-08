import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(__filename), "..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const pythonPath = venvPythonPath();

const results = [];

function pass(message) {
  results.push({ ok: true, message });
}

function fail(message, detail) {
  results.push({ ok: false, message, detail });
}

function warn(message, detail) {
  results.push({ ok: null, message, detail });
}

function commandExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0;
}

function checkNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= 20) {
    pass(`Node.js ${process.versions.node} is ready.`);
    return;
  }
  fail(`Node.js ${process.versions.node} is too old. Use Node.js 20 or newer.`);
}

function checkNpm() {
  if (commandExists(process.platform === "win32" ? "npm.cmd" : "npm")) {
    pass("npm is available.");
    return;
  }
  fail("npm was not found on PATH.");
}

function checkPythonVenv() {
  if (!fs.existsSync(pythonPath)) {
    fail(
      "The repo-local Python virtual environment is missing.",
      "Run: npm run desktop:bootstrap",
    );
    return;
  }

  const importCheck = spawnSync(
    pythonPath,
    [
      "-c",
      "import fastapi, multipart, pydicom, pydantic, sqlalchemy, uvicorn; print('clinical imports ok')",
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
    },
  );

  if (importCheck.status === 0) {
    pass("Python clinical dependencies are installed in .venv.");
    return;
  }

  fail(
    "Python clinical dependencies are incomplete.",
    "Run: npm run desktop:bootstrap",
  );
}

function venvPythonPath() {
  return process.platform === "win32"
    ? path.join(workspaceRoot, ".venv", "Scripts", "python.exe")
    : path.join(workspaceRoot, ".venv", "bin", "python");
}

function checkNodeDependencies() {
  const electronMain = path.join(workspaceRoot, "node_modules", "electron");
  const nextPackage = path.join(workspaceRoot, "node_modules", "next");
  const ohifPackage = path.join(workspaceRoot, "node_modules", "@ohif", "app");

  if (fs.existsSync(electronMain) && fs.existsSync(nextPackage) && fs.existsSync(ohifPackage)) {
    pass("Workspace Node dependencies are installed.");
    return;
  }

  fail(
    "Workspace Node dependencies are incomplete.",
    "Run: npm install --legacy-peer-deps",
  );
}

function checkViewerDist() {
  const viewerIndex = path.join(workspaceRoot, "viewer", "dist", "index.html");
  if (fs.existsSync(viewerIndex)) {
    pass("OHIF viewer dist is already built.");
    return;
  }

  warn(
    "OHIF viewer dist is not built yet.",
    "The desktop launcher will run `npm run build --workspace viewer` on first launch.",
  );
}

function checkFrontendBuild() {
  const frontendBuild = path.join(workspaceRoot, "frontend", ".next", "BUILD_ID");
  if (fs.existsSync(frontendBuild)) {
    pass("Next.js production shell is already built.");
    return;
  }

  warn(
    "Next.js production shell is not built yet.",
    "The desktop launcher will run `npm run build --workspace frontend` on first production-mode launch.",
  );
}

function checkDesktopFiles() {
  const required = [
    "desktop/src/main.mjs",
    "desktop/src/preload.cjs",
    "desktop/scripts/bootstrap.mjs",
    "desktop/scripts/dev-frontend.mjs",
    "desktop/scripts/startup-smoke.mjs",
    "frontend/package.json",
    "viewer/package.json",
    "backend/server.py",
  ];
  const missing = required.filter((relativePath) => !fs.existsSync(path.join(workspaceRoot, relativePath)));

  if (missing.length === 0) {
    pass("Desktop runtime files are present.");
    return;
  }

  fail(`Missing desktop runtime files: ${missing.join(", ")}`);
}

checkNode();
checkNpm();
checkDesktopFiles();
checkPythonVenv();
checkNodeDependencies();
checkViewerDist();
checkFrontendBuild();

console.log("RadSysX desktop doctor");
console.log("----------------------");
for (const result of results) {
  const marker = result.ok === true ? "[ok]" : result.ok === false ? "[fail]" : "[warn]";
  console.log(`${marker} ${result.message}`);
  if (result.detail) {
    console.log(`  ${result.detail}`);
  }
}

const failed = results.filter((result) => result.ok === false);
if (failed.length > 0) {
  console.log("");
  console.log("Fast path bootstrap:");
  console.log("  npm run desktop:bootstrap");
  console.log("  npm run desktop");
  process.exit(1);
}

console.log("");
console.log("Desktop fast path is ready:");
console.log("  npm run desktop");
