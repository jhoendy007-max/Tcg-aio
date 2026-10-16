import { ipcMain, type BrowserWindow } from "electron"
import QRCode from "qrcode"
import { relayRestockUrl, type AlertService } from "../engine/alerts"
import { postDiscord } from "../engine/discord"
import { checkStoreHealth } from "../engine/health"
import { defaultHttp } from "../engine/http"
import type { Database } from "../engine/database"
import { testProxies } from "../engine/proxy-test"
import type { TaskService } from "../engine/task-runner"
import type { PhoneServer } from "../phone/server"
import { encodePairingPayload } from "../phone/protocol"
import { channels } from "../shared/ipc"
import type { Result, Settings, TaskEvent } from "../shared/types"
import { listStores } from "../stores/registry"
import type { StoreId } from "../shared/types"
import type { StoreModule } from "../stores/module"

export function registerIpc(
  db: Database,
  runner: TaskService,
  registry: Map<StoreId, StoreModule>,
  getWindow: () => BrowserWindow | null,
  phone: PhoneServer,
  alerts: AlertService
): void {
  const publishAlerts = () => {
    const status = phone.status()
    alerts.setUrls({
      localUrl: `http://${status.host}:${status.port}/v1/restock`,
      relayUrl: relayRestockUrl(status.relay, db.pcId())
    })
    const view = alerts.view({
      localUrl: `http://${status.host}:${status.port}/v1/restock`,
      relayUrl: relayRestockUrl(status.relay, db.pcId())
    })
    getWindow()?.webContents.send(channels.alertsEvent, view)
    phone.publishAlerts(alerts.phoneAlerts())
    return view
  }
  handle(channels.tasksList, () => db.listTasks())
  handle(channels.tasksSave, (input) => db.saveTask(input))
  handle(channels.tasksDelete, (id: string) => {
    if (runner.isRunning(id)) throw new Error("Stop the task before deleting it.")
    db.deleteTask(id)
    getWindow()?.webContents.send(channels.taskEvent, { type: "delete", id } satisfies TaskEvent)
    return { id }
  })
  handle(channels.tasksStart, (id: string) => {
    runner.start(id)
    return { started: true as const }
  })
  handle(channels.tasksTest, (id: string) => {
    runner.start(id, { test: true })
    return { started: true as const }
  })
  handle(channels.healthCheck, (proxyGroupId: string | null) => {
    const proxies = proxyGroupId ? db.getProxyGroup(proxyGroupId).proxies : []
    return checkStoreHealth(defaultHttp, proxies)
  })
  handle(channels.tasksStop, (id: string) => {
    runner.stop(id)
    return { stopped: true as const }
  })
  handle(channels.profilesList, () => db.listProfiles())
  handle(channels.profilesSave, (input) => db.saveProfile(input))
  handle(channels.profilesDelete, (id: string) => {
    db.deleteProfile(id)
    return { id }
  })
  handle(channels.proxiesList, () => db.listProxyGroups())
  handle(channels.proxiesSave, (input) => db.saveProxyGroup(input))
  handle(channels.proxiesDelete, (id: string) => {
    db.deleteProxyGroup(id)
    return { id }
  })
  handle(channels.proxiesTest, (id: string) => testProxies(db.getProxyGroup(id).proxies))
  handle(channels.accountsList, () => db.listAccounts())
  handle(channels.accountsSave, (input) => db.saveAccount(input))
  handle(channels.accountsDelete, (id: string) => {
    db.deleteAccount(id)
    return { id }
  })
  handle(channels.settingsGet, () => ({ settings: db.getSettings(), security: db.security() }))
  handle(channels.settingsSave, (input: Settings) => {
    db.saveSettings(input)
    return { settings: db.getSettings(), security: db.security() }
  })
  handle(channels.settingsTest, async () => {
    const webhook = db.getSettings().discordWebhook
    if (!webhook) throw new Error("Save a Discord webhook first.")
    await postDiscord(webhook, {
      kind: "success",
      storeName: "TCGAIO",
      sku: "Webhook test",
      profileName: "Settings",
      detail: "Discord notifications are connected."
    })
    return { delivered: true as const }
  })
  handle(channels.storesList, () => listStores(registry))
  handle(channels.phoneStatus, () => phone.status())
  handle(channels.phoneInvite, async () => {
    const payload = phone.createInvite()
    const text = encodePairingPayload(payload)
    const qrDataUrl = await QRCode.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: "M", color: { dark: "#14161b", light: "#ffffff" } })
    return { ...phone.status(), text, qrDataUrl }
  })
  handle(channels.phoneRevoke, (id: string) => {
    phone.revoke(id)
    return phone.status()
  })
  handle(channels.phoneRelay, (url: string) => {
    db.saveSettings({ ...db.getSettings(), phoneRelayUrl: url })
    phone.reconnectRelay()
    publishAlerts()
    return phone.status()
  })
  handle(channels.alertsGet, () => publishAlerts())
  handle(channels.alertsRotateToken, () => {
    db.rotateRestockToken()
    return publishAlerts()
  })
  handle(channels.alertsSaveDiscord, (input) => {
    db.saveDiscordWatch(input)
    alerts.refresh()
    return publishAlerts()
  })
  handle(channels.alertsSaveRule, (input) => {
    const rule = db.saveRestockRule(input)
    alerts.refresh()
    publishAlerts()
    return rule
  })
  handle(channels.alertsDeleteRule, (id: string) => {
    db.deleteRestockRule(id)
    alerts.refresh()
    publishAlerts()
    return { id }
  })
  handle(channels.alertsSaveWatch, (input) => {
    const watch = db.saveWatch(input)
    alerts.refresh()
    publishAlerts()
    return watch
  })
  handle(channels.alertsDeleteWatch, (id: string) => {
    db.deleteWatch(id)
    alerts.refresh()
    publishAlerts()
    return { id }
  })
  handle(channels.alertsResumeWatch, (id: string) => {
    const watch = db.resumeWatch(id)
    alerts.refresh()
    publishAlerts()
    return watch
  })
}

function handle<T>(channel: string, fn: (...args: never[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await fn(...(args as never[]))
      return { ok: true, data } satisfies Result<T>
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Result<never>
    }
  })
}
