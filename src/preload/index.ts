import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { AioApi } from "../shared/api"
import { channels } from "../shared/ipc"
import type { PhoneStatus } from "../phone/protocol"
import type { AlertsView, PublicChallenge, TaskEvent, UpdateStatus } from "../shared/types"

const api: AioApi = {
  tasks: {
    list: () => ipcRenderer.invoke(channels.tasksList),
    save: (input) => ipcRenderer.invoke(channels.tasksSave, input),
    delete: (id) => ipcRenderer.invoke(channels.tasksDelete, id),
    reorder: (ids) => ipcRenderer.invoke(channels.tasksReorder, ids),
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
    test: (id) => ipcRenderer.invoke(channels.proxiesTest, id),
    storeTest: (id) => ipcRenderer.invoke(channels.proxiesStoreTest, id),
    siteTest: (id, url) => ipcRenderer.invoke(channels.proxiesSiteTest, id, url),
    monitorTest: (id, store) => ipcRenderer.invoke(channels.proxiesMonitorTest, id, store),
    health: () => ipcRenderer.invoke(channels.proxiesHealth)
  },
  accounts: {
    list: () => ipcRenderer.invoke(channels.accountsList),
    save: (input) => ipcRenderer.invoke(channels.accountsSave, input),
    delete: (id) => ipcRenderer.invoke(channels.accountsDelete, id),
    openBrowser: (id) => ipcRenderer.invoke(channels.sessionOpen, id),
    openInMyBrowser: (id) => ipcRenderer.invoke(channels.sessionOpenExternal, id),
    captureBrowser: (id) => ipcRenderer.invoke(channels.sessionCapture, id),
    warm: (id) => ipcRenderer.invoke(channels.sessionWarm, id)
  },
  clients: {
    list: () => ipcRenderer.invoke(channels.clientsList),
    summaries: () => ipcRenderer.invoke(channels.clientsSummaries),
    save: (input) => ipcRenderer.invoke(channels.clientsSave, input),
    delete: (id) => ipcRenderer.invoke(channels.clientsDelete, id),
    exportData: (id) => ipcRenderer.invoke(channels.clientsExport, id),
    ledger: (clientId) => ipcRenderer.invoke(channels.clientsLedger, clientId),
    markPaid: (clientId, ids, paid) => ipcRenderer.invoke(channels.clientsMarkPaid, { clientId, ids, paid }),
    csv: (clientId) => ipcRenderer.invoke(channels.clientsCsv, clientId)
  },
  checkoutHealth: {
    preview: (input) => ipcRenderer.invoke(channels.checkoutHealthPreview, input),
    client: (clientId) => ipcRenderer.invoke(channels.checkoutHealthClient, clientId),
    tasks: () => ipcRenderer.invoke(channels.checkoutHealthTasks)
  },
  settings: {
    get: () => ipcRenderer.invoke(channels.settingsGet),
    save: (input) => ipcRenderer.invoke(channels.settingsSave, input),
    testWebhook: () => ipcRenderer.invoke(channels.settingsTest),
    saveModule: (store, record) => ipcRenderer.invoke(channels.moduleSave, { store, record }),
    resetModule: (store) => ipcRenderer.invoke(channels.moduleReset, store),
    importModule: (text) => ipcRenderer.invoke(channels.moduleImport, text)
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
  },
  challenge: {
    get: () => ipcRenderer.invoke(channels.challengeGet),
    open: () => ipcRenderer.invoke(channels.challengeOpen),
    done: () => ipcRenderer.invoke(channels.challengeDone),
    submit: (cookie) => ipcRenderer.invoke(channels.challengeSubmit, cookie),
    dismiss: () => ipcRenderer.invoke(channels.challengeDismiss),
    onEvent: (cb: (challenge: PublicChallenge | null) => void) => {
      const listener = (_event: IpcRendererEvent, payload: PublicChallenge | null) => cb(payload)
      ipcRenderer.on(channels.challengeEvent, listener)
      return () => ipcRenderer.removeListener(channels.challengeEvent, listener)
    }
  },
  schedules: {
    list: () => ipcRenderer.invoke(channels.schedulesList),
    save: (input) => ipcRenderer.invoke(channels.schedulesSave, input),
    delete: (id) => ipcRenderer.invoke(channels.schedulesDelete, id)
  },
  calendar: {
    list: () => ipcRenderer.invoke(channels.calendarList),
    save: (input) => ipcRenderer.invoke(channels.calendarSave, input),
    delete: (id) => ipcRenderer.invoke(channels.calendarDelete, id),
    importFeed: (text) => ipcRenderer.invoke(channels.calendarImport, text),
    create: (input) => ipcRenderer.invoke(channels.calendarCreate, input)
  },
  analytics: {
    get: () => ipcRenderer.invoke(channels.analyticsGet),
    csv: () => ipcRenderer.invoke(channels.analyticsCsv)
  },
  bulk: {
    create: (input) => ipcRenderer.invoke(channels.tasksBulk, input),
    edit: (input) => ipcRenderer.invoke(channels.tasksBulkEdit, input),
    duplicate: (ids) => ipcRenderer.invoke(channels.tasksDuplicate, ids),
    clone: (taskId, accountIds) => ipcRenderer.invoke(channels.tasksClone, taskId, accountIds),
    delete: (ids) => ipcRenderer.invoke(channels.tasksDeleteMany, ids)
  },
  updates: {
    get: () => ipcRenderer.invoke(channels.updatesGet),
    check: () => ipcRenderer.invoke(channels.updatesCheck),
    download: () => ipcRenderer.invoke(channels.updatesDownload),
    install: () => ipcRenderer.invoke(channels.updatesInstall),
    saveToken: (input) => ipcRenderer.invoke(channels.updatesToken, input),
    onEvent: (cb: (status: UpdateStatus) => void) => {
      const listener = (_event: IpcRendererEvent, payload: UpdateStatus) => cb(payload)
      ipcRenderer.on(channels.updatesEvent, listener)
      return () => ipcRenderer.removeListener(channels.updatesEvent, listener)
    }
  },
  autopilot: {
    list: () => ipcRenderer.invoke(channels.templatesList),
    save: (input) => ipcRenderer.invoke(channels.templatesSave, input),
    delete: (id) => ipcRenderer.invoke(channels.templatesDelete, id),
    orders: () => ipcRenderer.invoke(channels.ordersList),
    imap: () => ipcRenderer.invoke(channels.imapGet),
    saveImap: (input) => ipcRenderer.invoke(channels.imapSave, input)
  },
  shipments: {
    list: () => ipcRenderer.invoke(channels.shipmentsList),
    scan: () => ipcRenderer.invoke(channels.shipmentsScan)
  },
  mail: {
    list: () => ipcRenderer.invoke(channels.mailboxesGet),
    save: (input) => ipcRenderer.invoke(channels.mailboxSave, input),
    delete: (id) => ipcRenderer.invoke(channels.mailboxDelete, id),
    test: (id) => ipcRenderer.invoke(channels.mailboxTest, id),
    signIn: (input) => ipcRenderer.invoke(channels.mailboxOAuth, input),
    open: (url) => ipcRenderer.invoke(channels.mailOpen, url)
  },
  resale: {
    quote: (input) => ipcRenderer.invoke(channels.resaleQuote, input)
  },
  inventory: {
    get: () => ipcRenderer.invoke(channels.inventoryGet),
    setValue: (id, value) => ipcRenderer.invoke(channels.inventoryValue, id, value),
    csv: () => ipcRenderer.invoke(channels.inventoryCsv)
  },
  backup: {
    exportFile: (passphrase) => ipcRenderer.invoke(channels.backupExport, passphrase),
    restoreFile: (passphrase, file) => ipcRenderer.invoke(channels.backupRestore, passphrase, file),
    saveToken: (input) => ipcRenderer.invoke(channels.backupToken, input),
    upload: (passphrase) => ipcRenderer.invoke(channels.backupUpload, passphrase),
    download: (passphrase) => ipcRenderer.invoke(channels.backupDownload, passphrase)
  },
  account: {
    status: () => ipcRenderer.invoke(channels.accountStatus),
    signIn: (input) => ipcRenderer.invoke(channels.accountSignIn, input),
    signUp: (input) => ipcRenderer.invoke(channels.accountSignUp, input),
    redeem: (input) => ipcRenderer.invoke(channels.accountRedeem, input),
    signOut: () => ipcRenderer.invoke(channels.accountSignOut),
    transfer: () => ipcRenderer.invoke(channels.accountTransfer),
    openAdmin: () => ipcRenderer.invoke(channels.accountOpenAdmin)
  },
  vault: {
    list: () => ipcRenderer.invoke(channels.vaultList),
    unlink: (deviceId: string, accountId: string) => ipcRenderer.invoke(channels.vaultUnlink, deviceId, accountId),
    setTwoWay: (deviceId: string, accountId: string, twoWay: boolean) => ipcRenderer.invoke(channels.vaultTwoWay, deviceId, accountId, twoWay)
  }
}

contextBridge.exposeInMainWorld("aio", api)
