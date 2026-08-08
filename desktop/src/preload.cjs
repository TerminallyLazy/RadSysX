const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("radsysxDesktop", {
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  selectLocalImagingFiles: (options = {}) =>
    ipcRenderer.invoke("radsysx:select-local-imaging", {
      mode: options.mode === "folder" ? "folder" : "files",
    }),
  importLocalImaging: (options = {}) =>
    ipcRenderer.invoke("radsysx:import-local-imaging", {
      mode: options.mode === "folder" ? "folder" : "files",
    }),
});
