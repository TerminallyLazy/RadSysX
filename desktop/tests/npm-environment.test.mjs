import test from "node:test";
import assert from "node:assert/strict";
import { projectInstallEnvironment } from "../scripts/npm-environment.mjs";

test("nested npm install restores the identical file policy and retains stricter flags", () => {
  const parent = { PATH: "/bin", npm_config_allow_scripts: "sharp,electron", npm_config_ignore_scripts: "true", RADSYSX_NVIDIA_API_KEY: "private" };
  const result = projectInstallEnvironment(parent, environment => {
    assert.equal(environment.npm_config_allow_scripts, undefined);
    return "electron,sharp";
  });
  assert.deepEqual(result, { PATH: "/bin", npm_config_ignore_scripts: "true" });
  assert.equal(parent.npm_config_allow_scripts, "sharp,electron");
});

test("a missing, different, or unreadable persisted policy fails closed", () => {
  for (const policy of [null, "", "electron", "electron,sharp,unapproved"]) {
    assert.throws(() => projectInstallEnvironment({ NPM_CONFIG_ALLOW_SCRIPTS: "electron,sharp" }, () => policy), /will not weaken/);
  }
  assert.throws(() => projectInstallEnvironment({ npm_config_allow_scripts: "electron", NPM_CONFIG_ALLOW_SCRIPTS: "sharp" }, () => "electron"), /will not weaken/);
});

test("a direct invocation preserves ordinary npm configuration without a policy probe", () => {
  assert.deepEqual(projectInstallEnvironment({ npm_config_strict_allow_scripts: "true" }, () => { throw Error("Unexpected probe"); }), { npm_config_strict_allow_scripts: "true" });
});
