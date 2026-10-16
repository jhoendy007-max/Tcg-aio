import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { AioApi } from "../shared/api"
import { channels } from "../shared/ipc"
import type { PhoneStatus } from "../phone/protocol"
import type { AlertsView, TaskEvent } from "../shared/types"

const api: AioApi = {
  tasks: {
    list: () => ipcRenderer.invoke(channels.tasksList),
    save: (input) => ipcRenderer.invoke(channels.tasksSave, input),
    delete: (id) => ipcRenderer.invoke(channels.tasksDelete, id),
    start: (id) => ipcRenderer.invoke(channels.tasksStart, id),
    test: (id) => ipcRenderer.invoke(channels.tasksTest, id),
    stop: (id) => ipcRenderer.invoke(channels.tasksStop, id),
    onEvent: (cb) => {
      const listener = (_event: IpcRendererEvent, payload: TaskEvent) => cb(payload)
      ipcRenderer.on(channels.taskEvent, listener)
      return () => ipcRenderer.removeListener(channels.taskEvent, listener)
    }
  },
  health: {
    check: (proxyGroupId) => ipcRenderer.invoke(channels.healthCheck, proxyGroupId)
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
  },
  phone: {
    status: () => ipcRenderer.invoke(channels.phoneStatus),
    invite: () => ipcRenderer.invoke(channels.phoneInvite),
    revoke: (id: string) => ipcRenderer.invoke(channels.phoneRevoke, id),
    saveRelay: (url: string) => ipcRenderer.invoke(channels.phoneRelay, url),
    onEvent: (cb: (status: PhoneStatus) => void) => {
      const listener = (_event: IpcRendererEvent, payload: PhoneStatus) => cb(payload)
      ipcRenderer.on(channels.phoneEvent, listener)
      return () => ipcRenderer.removeListener(channels.phoneEvent, listener)
    }
  },
  alerts: {
    get: () => ipcRenderer.invoke(channels.alertsGet),
    rotateToken: () => ipcRenderer.invoke(channels.alertsRotateToken),
    saveDiscord: (input) => ipcRenderer.invoke(channels.alertsSaveDiscord, input),
    saveRule: (input) => ipcRenderer.invoke(channels.alertsSaveRule, input),
    deleteRule: (id) => ipcRenderer.invoke(channels.alertsDeleteRule, id),
    saveWatch: (input) => ipcRenderer.invoke(channels.alertsSaveWatch, input),
    deleteWatch: (id) => ipcRenderer.invoke(channels.alertsDeleteWatch, id),
    resumeWatch: (id) => ipcRenderer.invoke(channels.alertsResumeWatch, id),
    onEvent: (cb: (view: AlertsView) => void) => {
      const listener = (_event: IpcRendererEvent, payload: AlertsView) => cb(payload)
      ipcRenderer.on(channels.alertsEvent, listener)
      return () => ipcRenderer.removeListener(channels.alertsEvent, listener)
    }
  }
}

contextBridge.exposeInMainWorld("aio", api)
