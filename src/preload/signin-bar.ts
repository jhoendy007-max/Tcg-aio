import { contextBridge, ipcRenderer } from "electron"

/** Preload for the sign-in bar only. It never loads in a store page. */
contextBridge.exposeInMainWorld("zzzBar", {
  copy: (field: "user" | "pass"): Promise<boolean> => ipcRenderer.invoke("signin-bar:copy", field),
  reveal: (show: boolean): Promise<string> => ipcRenderer.invoke("signin-bar:reveal", show)
})
