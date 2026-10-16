import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { AioApi } from "../shared/api"
import { channels } from "../shared/ipc"
import type { TaskEvent } from "../shared/types"

const api: AioApi = {
  tasks: {
    list: () => ipcRenderer.invoke(channels.tasksList),
    save: (input) => ipcRenderer.invoke(channels.tasksSave, input),
    delete: (id) => ipcRenderer.invoke(channels.tasksDelete, id),
    start: (id) => ipcRenderer.invoke(channels.tasksStart, id),
    stop: (id) => ipcRenderer.invoke(channels.tasksStop, id),
    onEvent: (cb) => {
      const listener = (_event: IpcRendererEvent, payload: TaskEvent) => cb(payload)
      ipcRenderer.on(channels.taskEvent, listener)
      return () => ipcRenderer.removeListener(channels.taskEvent, listener)
    }
  },
  profiles: {
    list: () => ipcRenderer.invoke(channels.profilesList),
    save: (input) => ipcRenderer.invoke(channels.profilesSave, input),
    delete: (id) => ipcRenderer.invoke(channels.profilesDelete, id)
  },
  proxies: {
    list: () => ipcRenderer.invoke(channels.proxiesList),
    save: (input) => ipcRenderer.invoke(channels.proxiesSave, input),
    delete: (id) => ipcRenderer.invoke(channels.proxiesDelete, id),
    test: (id) => ipcRenderer.invoke(channels.proxiesTest, id)
  },
  accounts: {
    list: () => ipcRenderer.invoke(channels.accountsList),
    save: (input) => ipcRenderer.invoke(channels.accountsSave, input),
    delete: (id) => ipcRenderer.invoke(channels.accountsDelete, id)
  },
  settings: {
    get: () => ipcRenderer.invoke(channels.settingsGet),
    save: (input) => ipcRenderer.invoke(channels.settingsSave, input),
    testWebhook: () => ipcRenderer.invoke(channels.settingsTest)
  },
  stores: {
    list: () => ipcRenderer.invoke(channels.storesList)
  }
}

contextBridge.exposeInMainWorld("aio", api)
