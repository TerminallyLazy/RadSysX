import { spawnSync } from "node:child_process";
import { publicChildEnvironment } from "../src/environment.mjs";

const policyNames = name => name.toLowerCase() === "npm_config_allow_scripts";
const normalize = value => JSON.stringify([...new Set(String(value).split(",").map(v => v.trim()).filter(Boolean))].sort());

// npm run exports .npmrc settings into the environment. npm 11 then treats
// allow-scripts as a forbidden CLI policy in a nested project install. Restore
// the file-backed policy only after proving that it is the same policy.
export function projectInstallEnvironment(parent, readPolicy) {
  const environment = publicChildEnvironment(parent);
  const inherited = Object.entries(environment).filter(([name, value]) => policyNames(name) && value);
  if (!inherited.length) return environment;
  const candidate = Object.fromEntries(Object.entries(environment).filter(([name]) => !policyNames(name)));
  const persisted = readPolicy(candidate);
  if (typeof persisted !== "string" || inherited.some(([, value]) => normalize(value) !== normalize(persisted))) {
    throw new Error("npm install-script policy differs from .npmrc. Persist the intended allow-scripts policy in .npmrc before running desktop bootstrap; RadSysX will not weaken it.");
  }
  return candidate;
}

export function npmInstallEnvironment(parent, cwd, command) {
  return projectInstallEnvironment(parent, environment => {
    const result = spawnSync(command, ["config", "get", "allow-scripts"], {
      cwd, env: environment, encoding: "utf8", timeout: 10000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  });
}
