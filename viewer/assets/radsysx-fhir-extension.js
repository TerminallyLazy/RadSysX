// @ts-check

(function radsysxFhirExtension() {
  const EXTENSION_ID = "@ohif/fhir-viewer";

  window.__RADSYSX_FHIR_EXTENSION__ = {
    id: EXTENSION_ID,
    getDataSourcesModule() {
      exposeOhifCorePeer();
      const bundle = window.__RADSYSX_LOAD_FHIR_DATASOURCE__?.();
      if (typeof bundle?.default !== "function") {
        throw new Error("The RadSysX FHIR data source bundle is unavailable.");
      }
      return bundle.default();
    },
  };

  function exposeOhifCorePeer() {
    const existing = window["@ohif/core"];
    if (isOhifCore(existing)) {
      return;
    }

    let webpackRequire;
    const chunkQueue = window.webpackChunk;
    if (!Array.isArray(chunkQueue)) {
      throw new Error("The OHIF webpack runtime is unavailable.");
    }

    chunkQueue.push([
      ["radsysx-fhir-core-peer"],
      {},
      (runtimeRequire) => {
        webpackRequire = runtimeRequire;
      },
    ]);

    if (!webpackRequire?.m) {
      throw new Error("The OHIF module registry is unavailable.");
    }

    for (const [moduleId, factory] of Object.entries(webpackRequire.m)) {
      const source = String(factory);
      if (
        !source.includes("services_DicomMetadataStore") ||
        !source.includes("DataSources_IWebApiDataSource")
      ) {
        continue;
      }

      const moduleExports = webpackRequire(moduleId);
      const core = Object.values(moduleExports).find(isOhifCore);
      if (core) {
        window["@ohif/core"] = core;
        return;
      }
    }

    throw new Error("The bundled OHIF core peer could not be resolved.");
  }

  function isOhifCore(value) {
    return Boolean(
      value?.DicomMetadataStore &&
        value?.IWebApiDataSource &&
        value?.classes?.MetadataProvider &&
        value?.utils?.addAccessors,
    );
  }
})();
