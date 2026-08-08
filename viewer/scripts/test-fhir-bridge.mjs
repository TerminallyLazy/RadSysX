import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const bridgeSource = fs.readFileSync(
  path.resolve(scriptsRoot, "../assets/radsysx-fhir-extension.js"),
  "utf8",
);
const core = {
  DicomMetadataStore: {},
  IWebApiDataSource: {},
  classes: { MetadataProvider: class MetadataProvider {} },
  utils: { addAccessors() {} },
};
const moduleFactory = function services_DicomMetadataStore_DataSources_IWebApiDataSource() {};
const runtimeRequire = (moduleId) => (moduleId === "core" ? { default: core } : {});
runtimeRequire.m = { core: moduleFactory };

const window = {
  webpackChunk: [],
  __RADSYSX_LOAD_FHIR_DATASOURCE__: () => ({
    default: () => [{ name: "fhir", type: "webApi" }],
  }),
};
window.webpackChunk.push = (entry) => {
  entry[2](runtimeRequire);
};

vm.runInNewContext(bridgeSource, { window });

const modules = window.__RADSYSX_FHIR_EXTENSION__.getDataSourcesModule();
assert.equal(window["@ohif/core"], core);
assert.deepEqual(
  modules.map(({ name, type }) => ({ name, type })),
  [{ name: "fhir", type: "webApi" }],
);
