import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const bootstrapScript = path.join(scriptDir, "bootstrap.mjs");

const knownOptions = new Set(["--check-only", "--help", "--no-bootstrap", "--skip-check", "--smoke"]);
const cliOptions = process.argv.slice(2);
const unknownOptions = cliOptions.filter((option) => !knownOptions.has(option));
const checkOnly = cliOptions.includes("--check-only");
const noBootstrap = cliOptions.includes("--no-bootstrap") || isTruthy(process.env.RADSYSX_DESKTOP_SKIP_BOOTSTRAP);
const skipCheck = cliOptions.includes("--skip-check");
const smoke = cliOptions.includes("--smoke");

let activeChild = null;

async function main() {
  if (cliOptions.includes("--help")) {
    printHelp();
    return;
  }

  if (unknownOptions.length > 0) {
    throw new Error(`Unknown RadSysX desktop launch option(s): ${unknownOptions.join(", ")}`);
  }

  if (checkOnly) {
    await runBootstrapCheck();
    return;
  }

  if (!skipCheck) {
    const checkStatus = await runBootstrapCheck({ allowFailure: true });
    if (checkStatus !== 0) {
      if (noBootstrap) {
        throw new Error(
          "RadSysX desktop setup is incomplete. Run `npm run desktop:bootstrap`, or rerun `npm run desktop` without `--no-bootstrap`.",
        );
      }

      console.log("");
      console.log("RadSysX desktop setup is incomplete. Running the local bootstrap once...");
      await runCommand("bootstrap", process.execPath, [bootstrapScript]);
      console.log("");
      console.log("RadSysX desktop setup is ready. Opening the local OHIF app.");
    }
  }

  await launchElectron();
}

function runBootstrapCheck(options = {}) {
  return runCommand("bootstrap-check", process.execPath, [bootstrapScript, "--check"], options);
}

async function launchElectron() {
  const env = { ...process.env };
  if (smoke) {
    env.RADSYSX_DESKTOP_EXIT_AFTER_READY_MS = env.RADSYSX_DESKTOP_EXIT_AFTER_READY_MS ?? "1500";
  }

  const electronBinary = resolveElectronBinary();
  await runCommand("electron", electronBinary, ["--no-sandbox", "."], {
    cwd: desktopRoot,
    env,
  });
}

function resolveElectronBinary() {
  try {
    return require("electron");
  } catch (error) {
    throw new Error(
      `Electron is not installed. Run \`npm run desktop:bootstrap\`, then try again. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }
}

function runCommand(label, command, args, options = {}) {
  const cwd = options.cwd ?? workspaceRoot;
  const env = options.env ?? process.env;
  const allowFailure = options.allowFailure ?? false;

  console.log(`[${label}] ${command} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });

    activeChild = child;

    child.once("error", (error) => {
      if (activeChild === child) {
        activeChild = null;
      }
      if (allowFailure) {
        resolve(1);
      } else {
        reject(error);
      }
    });

    child.once("exit", (code, signal) => {
      if (activeChild === child) {
        activeChild = null;
      }

      const status = code ?? signalExitCode(signal);
      if (status === 0 || allowFailure) {
        resolve(status);
      } else if (signal) {
        reject(new Error(`${label} terminated by ${signal}.`));
      } else {
        reject(new Error(`${label} exited with ${status}.`));
      }
    });
  });
}

function signalExitCode(signal) {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

function isTruthy(value) {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function printHelp() {
  console.log(`RadSysX desktop launcher

Usage:
  npm run desktop
  npm run desktop -- --check-only

Options:
  --check-only    Verify the existing desktop bootstrap and exit.
  --no-bootstrap  Fail instead of running bootstrap when setup is incomplete.
  --skip-check    Open Electron without checking bootstrap first.
  --smoke         Set a short auto-exit timer for launcher smoke tests.
`);
}

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

function forwardSignal(signal) {
  if (activeChild && !activeChild.killed) {
    activeChild.kill(signal);
    return;
  }

  process.exit(signalExitCode(signal));
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
