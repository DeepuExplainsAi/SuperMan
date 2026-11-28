import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("desktop", Object.freeze({
  status: () => ipcRenderer.invoke("desktop:status"),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke("desktop:auto-start", enabled),
}));
