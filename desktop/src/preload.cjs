const { contextBridge, ipcRenderer } = require("electron");

const captureArguments = (options = {}) => ({
  sessionId: options.sessionId,
  contextVersion: options.contextVersion,
  targetId: options.targetId,
  viewportId: options.viewportId,
  leaseId: options.leaseId,
  rect: options.rect && { x: options.rect.x, y: options.rect.y, width: options.rect.width, height: options.rect.height },
});

contextBridge.exposeInMainWorld("radsysxDesktop", {
  studyCaptureVersion: 1,
  startStudyCapture: (options) => ipcRenderer.invoke("radsysx:start-study-capture", options),
  captureStudyObservation: (options) => ipcRenderer.invoke("radsysx:capture-study-observation", options),
  stopStudyCapture: (options) => ipcRenderer.invoke("radsysx:stop-study-capture", options),
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  startViewerCapture: (options) => ipcRenderer.invoke("radsysx:start-viewer-capture", captureArguments(options)),
  captureViewerFrame: (options) => ipcRenderer.invoke("radsysx:capture-viewer-frame", captureArguments(options)),
  stopViewerCapture: (options = {}) => ipcRenderer.invoke("radsysx:stop-viewer-capture", { leaseId: options.leaseId }),
  selectLocalImagingFiles: (options = {}) =>
    ipcRenderer.invoke("radsysx:select-local-imaging", {
      mode: options.mode === "folder" ? "folder" : "files",
    }),
  importLocalImaging: (options = {}) =>
    ipcRenderer.invoke("radsysx:import-local-imaging", {
      mode: options.mode === "folder" ? "folder" : "files",
    }),
});
