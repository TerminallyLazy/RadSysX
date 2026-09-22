import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function pinnedRequirements(file) {
  const pins = {};
  for (const source of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = source.split("#", 1)[0].trim();
    if (!line || /^-r\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9._-]+)==([^\s;]+)$/);
    if (!match) throw new Error(`Desktop dependencies require exact pins in ${path.basename(file)}.`);
    pins[match[1].toLowerCase().replace(/[-_.]+/g, "-")] = match[2];
  }
  return pins;
}

export function expectedAiVersions(workspaceRoot) {
  const ai = pinnedRequirements(path.join(workspaceRoot, "backend/requirements-ai.txt"));
  const clinical = pinnedRequirements(path.join(workspaceRoot, "backend/requirements-clinical.txt"));
  if (!Object.keys(ai).length || !clinical.httpx || !clinical.pydantic) throw new Error("Desktop AI dependency pins are incomplete.");
  return { ...ai, httpx: clinical.httpx, pydantic: clinical.pydantic };
}

export function dependencyMismatches(expected, installed) {
  return Object.entries(expected).flatMap(([name, version]) => installed[name] === version
    ? [] : [`${name}: expected ${version}, found ${installed[name] ?? "missing"}`]);
}

export function inspectAiDependencies(pythonPath, workspaceRoot) {
  const expected = expectedAiVersions(workspaceRoot);
  const inspection = spawnSync(pythonPath, ["-c", [
    "import json, sys",
    "from importlib.metadata import version, PackageNotFoundError",
    "versions = {}",
    "for package in json.loads(sys.argv[1]):",
    "    try: versions[package] = version(package)",
    "    except PackageNotFoundError: versions[package] = None",
    "print(json.dumps(versions))",
  ].join("\n"), JSON.stringify(Object.keys(expected))], { cwd: workspaceRoot, encoding: "utf8" });
  if (inspection.status !== 0) throw new Error("Unable to inspect Python AI dependency versions.");
  const installed = JSON.parse(inspection.stdout);
  return { expected, installed, mismatches: dependencyMismatches(expected, installed) };
}
