import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webpack = require(["web", "pack"].join(""));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viewerRoot = path.resolve(__dirname, "..");
const distRoot = path.join(viewerRoot, "dist");
const workspaceRoot = path.resolve(viewerRoot, "..");
const fhirVendorRoot = path.join(viewerRoot, "vendor", "ohif-fhir-viewer");
const candidateSourceDists = [
  path.join(viewerRoot, "node_modules", "@ohif", "app", "dist"),
  path.join(workspaceRoot, "node_modules", "@ohif", "app", "dist"),
];
const sourceDist = candidateSourceDists.find((candidate) => fs.existsSync(candidate));
const copiedRuntimeAssetNames = [
  "radsysx-bootstrap.js",
  "radsysx-fhir-extension.js",
  "radsysx-ohif-extension.js",
  "radsysx-ohif-mode.js",
  "radsysx-viewer.css",
];
const generatedRuntimeAssetNames = ["radsysx-fhir-datasource.js"];
const runtimeAssetNames = [...copiedRuntimeAssetNames, ...generatedRuntimeAssetNames];

if (!sourceDist) {
  throw new Error(
    "OHIF dist was not found. Run `npm install` from the workspace root before building the viewer.",
  );
}

fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(distRoot, { recursive: true });
fs.cpSync(sourceDist, distRoot, { recursive: true });

for (const assetName of copiedRuntimeAssetNames) {
  copyViewerAsset(assetName);
}
await buildFhirDataSourceBundle();
copyWorkspaceFile(["RadSysX-Logo.png"], "radsysx-logo.png");
copyWorkspaceFile(["RadSysX-Logo-Light.png"], "radsysx-logo-light.png");
copyWorkspaceAsset(["react", "umd", "react.production.min.js"], "react.production.min.js");
writeAppConfig();
patchIndexHtml();
patchRuntimePublicPath();
patchCssAssetUrls();
patchManifest();
patchServiceWorkerInit();
patchServiceWorkerPrecacheUrls();

function copyViewerAsset(fileName) {
  fs.copyFileSync(
    path.join(viewerRoot, "assets", fileName),
    path.join(distRoot, fileName),
  );
}

function copyWorkspaceAsset(relativeParts, outputName) {
  const assetPath = path.join(workspaceRoot, "node_modules", ...relativeParts);
  if (!fs.existsSync(assetPath)) {
    throw new Error(`Required viewer asset was not found: ${assetPath}`);
  }
  fs.copyFileSync(assetPath, path.join(distRoot, outputName));
}

function copyWorkspaceFile(relativeParts, outputName) {
  const assetPath = path.join(workspaceRoot, ...relativeParts);
  if (!fs.existsSync(assetPath)) {
    throw new Error(`Required viewer asset was not found: ${assetPath}`);
  }
  fs.copyFileSync(assetPath, path.join(distRoot, outputName));
}

function writeAppConfig() {
  const fhirConfiguration = {
    friendlyName: "FHIR R4 Server",
    smartScope:
      process.env.RADSYSX_FHIR_SCOPE?.trim() ||
      "launch openid fhirUser patient/*.read",
  };
  const fhirBaseUrl = process.env.RADSYSX_FHIR_SERVER_URL?.trim().replace(/\/+$/, "");
  const smartClientId = process.env.RADSYSX_FHIR_CLIENT_ID?.trim();
  if (fhirBaseUrl) {
    fhirConfiguration.fhirBaseUrl = fhirBaseUrl;
  }
  if (smartClientId) {
    fhirConfiguration.smartClientId = smartClientId;
  }

  const config = `/** @type {AppTypes.Config} */
(function radsysxAppConfig() {
  window.config = {
    name: "config/radsysx-clinical.js",
    routerBasename: window.__RADSYSX_VIEWER_BASE_PATH__ ?? null,
    extensions: [
      "@ohif/extension-default",
      "@ohif/extension-cornerstone",
      "@ohif/extension-measurement-tracking",
      "@ohif/extension-cornerstone-dicom-sr",
      "@ohif/extension-cornerstone-dicom-seg",
      "@ohif/extension-dicom-pdf",
      "@ohif/extension-dicom-video",
      window.__RADSYSX_FHIR_EXTENSION__,
      window.__RADSYSX_OHIF_EXTENSION__,
    ],
    modes: [
      window.__RADSYSX_OHIF_MODE__,
      window.__RADSYSX_FHIR_MODE__,
    ],
    customizationService: {},
    whiteLabeling: {
      createLogoComponentFn: function createLogoComponentFn(React) {
        return React.createElement(
          "a",
          {
            href: window.__RADSYSX_VIEWER_BASE_PATH__ ?? "/",
            target: "_self",
            rel: "noopener noreferrer",
            style: {
              display: "flex",
              alignItems: "center",
              paddingTop: "4px",
              paddingLeft: "12px",
              paddingRight: "8px",
            },
          },
          React.createElement("img", {
            src: (window.__RADSYSX_PUBLIC_URL__ || "./") + "radsysx-logo-light.png",
            alt: "RadSysX",
            style: {
              display: "block",
              height: "72px",
              width: "auto",
              maxWidth: "none",
            },
          }),
        );
      },
    },
    showStudyList: false,
    maxNumberOfWebWorkers: 3,
    showWarningMessageForCrossOrigin: true,
    showCPUFallbackMessage: true,
    showLoadingIndicator: true,
    defaultDataSourceName: "dicomweb",
    dataSources: [
      {
        namespace: "@radsysx/extension-clinical.dataSourcesModule.dicomweb",
        sourceName: "dicomweb",
        configuration: {
          friendlyName: "RadSysX Clinical DICOMweb",
          name: "radsysxOrthanc",
          qidoRoot: null,
          wadoRoot: null,
          wadoUriRoot: null,
          qidoSupportsIncludeField: true,
          supportsReject: false,
          supportsStow: false,
          dicomUploadEnabled: false,
          imageRendering: "wadors",
          thumbnailRendering: "wadors",
          enableStudyLazyLoad: true,
          supportsFuzzyMatching: true,
          supportsWildcard: true,
          omitQuotationForMultipartRequest: true,
          singlepart: "bulkdata,video",
        },
      },
      {
        namespace: "@ohif/fhir-viewer.dataSourcesModule.fhir",
        sourceName: "fhir",
        configuration: ${JSON.stringify(fhirConfiguration, null, 10)},
      },
      {
        namespace: "@ohif/extension-default.dataSourcesModule.dicomlocal",
        sourceName: "dicomlocal",
        configuration: {
          friendlyName: "Local DICOM files",
        },
      },
    ],
  };
})();
`;

  fs.writeFileSync(path.join(distRoot, "app-config.js"), config, "utf8");
}

async function buildFhirDataSourceBundle() {
  const temporaryName = ".radsysx-fhir-datasource.bundle.js";
  const temporaryPath = path.join(distRoot, temporaryName);
  const outputPath = path.join(distRoot, generatedRuntimeAssetNames[0]);
  const compiler = webpack({
    mode: "production",
    target: "web",
    entry: path.join(fhirVendorRoot, "src", "getDataSourcesModule.js"),
    devtool: false,
    performance: false,
    output: {
      path: distRoot,
      filename: temporaryName,
      library: "radsysx-fhir-datasource",
      libraryTarget: "umd",
      globalObject: "globalThis",
    },
    externals: {
      "@ohif/core": {
        commonjs: "@ohif/core",
        commonjs2: "@ohif/core",
        amd: "@ohif/core",
        root: "@ohif/core",
      },
    },
    module: {
      rules: [
        {
          test: /\.m?js$/,
          resolve: { fullySpecified: false },
        },
      ],
    },
    resolve: {
      modules: [
        path.join(viewerRoot, "node_modules"),
        path.join(workspaceRoot, "node_modules"),
      ],
      extensions: [".js"],
    },
  });

  const stats = await new Promise((resolve, reject) => {
    compiler.run((error, result) => {
      compiler.close(() => {});
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });

  if (!stats || stats.hasErrors()) {
    throw new Error(
      `Unable to build the FHIR data source bundle.\n${stats?.toString({
        colors: false,
        errors: true,
        warnings: false,
      }) ?? "Webpack returned no build result."}`,
    );
  }

  const bundle = fs.readFileSync(temporaryPath, "utf8");
  const wrapped = `// Bundled from node-on-fhir/ohif-fhir-viewer at 0935326fcc1eac519929734b061b5a6d645409b1.
(function registerRadSysXFhirDataSource() {
  let loadedBundle;
  window.__RADSYSX_LOAD_FHIR_DATASOURCE__ = function loadRadSysXFhirDataSource() {
    if (!loadedBundle) {
      ${bundle}
      loadedBundle = globalThis["radsysx-fhir-datasource"];
    }
    return loadedBundle;
  };
})();
`;
  fs.writeFileSync(outputPath, wrapped, "utf8");
  fs.rmSync(temporaryPath);

  const temporaryLicensePath = `${temporaryPath}.LICENSE.txt`;
  if (fs.existsSync(temporaryLicensePath)) {
    fs.renameSync(temporaryLicensePath, `${outputPath}.LICENSE.txt`);
  }
}

function patchIndexHtml() {
  const indexPath = path.join(distRoot, "index.html");
  let html = fs.readFileSync(indexPath, "utf8");
  const runtimeAssetVersion = runtimeAssetNames
    .map((assetName) => fs.statSync(path.join(distRoot, assetName)).mtimeMs)
    .reduce((latest, mtime) => Math.max(latest, mtime), 0)
    .toFixed(0);
  const publicUrlBootstrap = [
    "window.__RADSYSX_VIEWER_BASE_PATH__ = (function resolveViewerBasePath() {",
    "  const pathname = String((window.location && window.location.pathname) || '/');",
    "  const safePath = ('/' + pathname.replace(/^\\/+/, '')).replace(/\\/+$/, '');",
    "  const parts = safePath.split('/').filter(Boolean);",
    "  if (parts[0] === 'viewer') {",
    "    return '/viewer';",
    "  }",
    "  const basePath = /\\/[^/]+\\.[^/]+$/.test(safePath) ? safePath.replace(/\\/[^/]+$/, '') : safePath;",
    "  const normalized = basePath || '/';",
    "  return normalized || '/';",
    "})();",
    "window.__RADSYSX_PUBLIC_URL__ =",
    "  window.__RADSYSX_VIEWER_BASE_PATH__ === '/' ? '/' : `${window.__RADSYSX_VIEWER_BASE_PATH__}/`;",
    "document.write('<base href=\"' + window.__RADSYSX_PUBLIC_URL__.replace(/\"/g, '&quot;') + '\">');",
    "window.PUBLIC_URL = window.__RADSYSX_PUBLIC_URL__;",
  ].join(" ");

  html = html.replace("window.PUBLIC_URL = '/';", publicUrlBootstrap);
  html = html.replace("window.PUBLIC_URL = '/';", "window.PUBLIC_URL = window.__RADSYSX_PUBLIC_URL__;");
  html = html.replace(/(src|href|content)=\"\/assets\//g, '$1="assets/');
  html = html.replace(/(src|href)=\"\//g, '$1="');
  html = html.replace(
    '<script rel="preload" as="script" src="app-config.js"></script>',
    [
      '<script src="react.production.min.js"></script>',
      `<script src="radsysx-bootstrap.js?v=${runtimeAssetVersion}"></script>`,
      `<script src="radsysx-fhir-datasource.js?v=${runtimeAssetVersion}"></script>`,
      `<script src="radsysx-fhir-extension.js?v=${runtimeAssetVersion}"></script>`,
      `<script src="radsysx-ohif-extension.js?v=${runtimeAssetVersion}"></script>`,
      `<script src="radsysx-ohif-mode.js?v=${runtimeAssetVersion}"></script>`,
      '<script rel="preload" as="script" src="app-config.js"></script>',
    ].join(""),
  );
  html = html.replace(
    "</head>",
    `<link href="radsysx-viewer.css?v=${runtimeAssetVersion}" rel="stylesheet"></head>`,
  );

  fs.writeFileSync(indexPath, html, "utf8");
}

function patchRuntimePublicPath() {
  const bundlePaths = fs
    .readdirSync(distRoot)
    .filter((fileName) => fileName.endsWith(".js"))
    .filter(
      (fileName) =>
        ![
          "app-config.js",
          "init-service-worker.js",
          "react.production.min.js",
          "radsysx-bootstrap.js",
          "radsysx-fhir-datasource.js",
          "radsysx-fhir-extension.js",
          "radsysx-ohif-extension.js",
          "radsysx-ohif-mode.js",
          "sw.js",
        ].includes(fileName),
    )
    .map((fileName) => path.join(distRoot, fileName));
  const current = /__webpack_require__\.p\s*=\s*["']\/["'];/g;
  const next = `__webpack_require__.p = ((function resolveRadSysXPublicUrl() {
  function normalizePublicUrl(value) {
    if (!value) {
      return null;
    }

    const trimmed = String(value).trim();
    if (!trimmed) {
      return null;
    }

    if (/^[a-z]+:/i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        const currentOrigin =
          (typeof self !== "undefined" && self.location && self.location.origin) ||
          (typeof window !== "undefined" && window.location && window.location.origin) ||
          parsed.origin;
        if (parsed.origin !== currentOrigin) {
          return null;
        }
        return normalizePublicUrl(parsed.pathname);
      } catch {
        return null;
      }
    }

    if (!trimmed.startsWith("/")) {
      return null;
    }

    const normalized = ("/" + trimmed.replace(/^\\/+/, "")).replace(/\\/+$/, "");
    const basePath = /\\/[^/]+\\.[^/]+$/.test(normalized)
      ? normalized.replace(/\\/[^/]+$/, "")
      : normalized;
    return basePath === "/" ? "/" : basePath + "/";
  }

  const explicit =
    (typeof self !== "undefined" &&
      (self.__RADSYSX_PUBLIC_URL__ || self.PUBLIC_URL || self.__RADSYSX_VIEWER_BASE_PATH__)) ||
    (typeof window !== "undefined" &&
      (window.__RADSYSX_PUBLIC_URL__ || window.PUBLIC_URL || window.__RADSYSX_VIEWER_BASE_PATH__));
  const normalizedExplicit = normalizePublicUrl(explicit);
  if (normalizedExplicit) {
    return normalizedExplicit;
  }

  const locationPathname =
    (typeof self !== "undefined" && self.location && self.location.pathname) ||
    (typeof window !== "undefined" && window.location && window.location.pathname) ||
    "";
  const normalizedPathname = normalizePublicUrl(locationPathname);
  return normalizedPathname || "/";
})());`;
  let patchedCount = 0;

  for (const bundlePath of bundlePaths) {
    const bundle = fs.readFileSync(bundlePath, "utf8");
    const updated = bundle.replace(current, next);
    if (updated === bundle) {
      continue;
    }

    fs.writeFileSync(bundlePath, updated, "utf8");
    patchedCount += 1;
  }

  if (patchedCount === 0) {
    throw new Error(
      `Unable to patch OHIF runtime public path in copied dist bundles. Checked ${bundlePaths.length} bundles for the webpack public-path assignment.`,
    );
  }
}

function patchCssAssetUrls() {
  const cssPaths = fs
    .readdirSync(distRoot)
    .filter((fileName) => fileName.endsWith(".css"))
    .map((fileName) => path.join(distRoot, fileName));

  for (const cssPath of cssPaths) {
    const css = fs.readFileSync(cssPath, "utf8");
    const normalized = css.replace(/url\((['"]?)\//g, "url($1");
    if (normalized !== css) {
      fs.writeFileSync(cssPath, normalized, "utf8");
    }
  }
}

function patchManifest() {
  const manifestPath = path.join(distRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return;
  }

  const manifest = fs.readFileSync(manifestPath, "utf8");
  const normalized = manifest.replace(/"src": "\/assets\//g, '"src": "assets/');
  if (normalized !== manifest) {
    fs.writeFileSync(manifestPath, normalized, "utf8");
  }
}

function patchServiceWorkerInit() {
  const initPath = path.join(distRoot, "init-service-worker.js");
  if (!fs.existsSync(initPath)) {
    return;
  }

  const source = fs.readFileSync(initPath, "utf8");
  const current = `navigator.serviceWorker.getRegistrations().then(function (registrations) {
  for (let registration of registrations) {
    registration.unregister();
  }
});
`;
  const next = `if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (registrations) {
    for (let registration of registrations) {
      registration.unregister();
    }
  });
}
`;

  if (source.includes(current)) {
    fs.writeFileSync(initPath, source.replace(current, next), "utf8");
  }
}

function patchServiceWorkerPrecacheUrls() {
  const serviceWorkerPath = path.join(distRoot, "sw.js");
  if (!fs.existsSync(serviceWorkerPath)) {
    return;
  }

  const source = fs.readFileSync(serviceWorkerPath, "utf8");
  const normalized = source
    .replace(/('url':')\//g, "$1")
    .replace(/("url":")\//g, "$1");

  if (normalized !== source) {
    fs.writeFileSync(serviceWorkerPath, normalized, "utf8");
  }
}
