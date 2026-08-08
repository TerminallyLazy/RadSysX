import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const checkOnly = process.argv.includes("--check");
const venvDir = path.join(workspaceRoot, ".venv");
const requirementsPath = path.join(workspaceRoot, "backend", "requirements-clinical.txt");

async function main() {
  const python = findPython();
  if (!python) {
    throw new Error(
      "Python 3.10+ was not found. Install Python 3.12 if this environment will also use research dependencies, or set PYTHON=/path/to/python.",
    );
  }

  if (checkOnly) {
    await checkBootstrap(python);
    return;
  }

  await run("python", python.command, [...python.args, "-m", "venv", ".venv"]);
  await run("pip", venvPython(), ["-m", "pip", "install", "--upgrade", "pip"]);
  await run("python-deps", venvPython(), ["-m", "pip", "install", "-r", requirementsPath]);
  await run("npm", npmCommand(), ["install", "--legacy-peer-deps"]);
  await run("doctor", npmCommand(), ["run", "desktop:doctor"]);

  console.log("");
  console.log("RadSysX desktop bootstrap complete.");
  console.log("Next: npm run desktop");
}

async function checkBootstrap(python) {
  console.log(`Python candidate: ${python.label}`);
  assertFile(requirementsPath, "Clinical requirements file");
  assertFile(venvPython(), "Virtualenv Python");
  assertDirectory(path.join(workspaceRoot, "node_modules"), "Workspace node_modules");
  assertDirectory(path.join(workspaceRoot, "node_modules", "electron"), "Electron dependency");
  await run("python-imports", venvPython(), [
    "-c",
    "import fastapi, pydicom, sqlalchemy, uvicorn; print('clinical Python imports ready')",
  ]);
  await run("npm-version", npmCommand(), ["--version"]);
  console.log("RadSysX desktop bootstrap check passed.");
}

function findPython() {
  const candidates = [];
  const configuredPython = process.env.RADSYSX_DESKTOP_PYTHON ?? process.env.PYTHON;
  if (configuredPython) {
    candidates.push({ command: configuredPython, args: [], label: configuredPython });
  }

  if (process.platform === "win32") {
    candidates.push(
      { command: "py", args: ["-3"], label: "py -3" },
      { command: "python", args: [], label: "python" },
      { command: "python3", args: [], label: "python3" },
    );
  } else {
    candidates.push(
      { command: "python3", args: [], label: "python3" },
      { command: "python", args: [], label: "python" },
    );
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [
      ...candidate.args,
      "-c",
      "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)",
    ], {
      cwd: workspaceRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

function venvPython() {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} was not found at ${filePath}`);
  }
}

function assertDirectory(directoryPath, label) {
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    throw new Error(`${label} was not found at ${directoryPath}`);
  }
}

function run(label, command, args) {
  console.log(`[${label}] ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited with ${code ?? "unknown status"}.`));
      }
    });
  });
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
