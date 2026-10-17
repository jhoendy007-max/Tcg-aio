import { ipcMain, shell, type BrowserWindow } from "electron"
import QRCode from "qrcode"
import { relayRestockUrl, type AlertService } from "../engine/alerts"
import type { ChallengeController } from "./challenge-window"
import { postDiscord } from "../engine/discord"
import { checkStoreHealth } from "../engine/health"
import type { SessionBrowser } from "./session-window"
import type { UpdateController } from "./auto-update"
import { parseBulkTasks } from "../engine/bulk"
import { defaultHttp } from "../engine/http"
import type { Database } from "../engine/database"
import { testProxies } from "../engine/proxy-test"
import type { TaskService } from "../engine/task-runner"
import type { PhoneServer } from "../phone/server"
import { encodePairingPayload } from "../phone/protocol"
import { channels } from "../shared/ipc"
import { openMailbox, testMailbox } from "../engine/imap"
import { completeMailSignIn } from "../engine/mail-oauth"
import { imapCredential } from "../engine/mail-read"
import { explainMailFailure, isMailHelpUrl } from "../shared/mail"
import { AppError } from "../shared/errors"
import type { ImapInput, MailboxInput, Result, Settings, TaskEvent, TaskTemplateInput } from "../shared/types"
import { listStores } from "../stores/registry"
import type { StoreId } from "../shared/types"
import type { StoreModule } from "../stores/module"

export function registerIpc(
  db: Database,
  runner: TaskService,
  registry: Map<StoreId, StoreModule>,
  getWindow: () => BrowserWindow | null,
  phone: PhoneServer,
  alerts: AlertService,
  challenge: ChallengeController,
  sessions: SessionBrowser,
  updates: UpdateController,
  onSettings?: (settings: Settings) => void
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
  handle(channels.tasksReorder, (ids: string[]) => db.reorderTasks(Array.isArray(ids) ? ids : []))
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
  handle(channels.healthCheck, async (proxyGroupId: string | null) => {
    const proxies = proxyGroupId ? db.getProxyGroup(proxyGroupId).proxies : []
    return db.recordHealth(await checkStoreHealth(defaultHttp, proxies), proxies)
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
  handle(channels.proxiesHealth, () => db.proxyScores())
  handle(channels.accountsList, () => db.listAccounts())
  handle(channels.accountsSave, (input) => db.saveAccount(input))
  handle(channels.accountsDelete, (id: string) => {
    db.deleteAccount(id)
    return { id }
  })
  handle(channels.sessionOpen, async (id: string) => {
    await sessions.open(id)
    return { opened: true as const }
  })
  handle(channels.sessionCapture, async (id: string) => {
    await sessions.capture(id)
    return { saved: true as const }
  })
  handle(channels.sessionWarm, (id: string) => sessions.warm(id))
  handle(channels.settingsGet, () => ({ settings: db.getSettings(), security: db.security() }))
  handle(channels.settingsSave, (input: Settings) => {
    const settings = db.saveSettings(input)
    onSettings?.(settings)
    return { settings, security: db.security() }
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
  handle(channels.challengeGet, () => challenge.current())
  handle(channels.challengeOpen, async () => {
    await challenge.open()
    return { opened: true as const }
  })
  handle(channels.challengeDone, async () => {
    await challenge.complete()
    return { saved: true as const }
  })
  handle(channels.challengeSubmit, (cookie: string) => {
    challenge.submit(cookie)
    return { saved: true as const }
  })
  handle(channels.challengeDismiss, () => {
    challenge.dismiss()
    return { dismissed: true as const }
  })
  handle(channels.schedulesList, () => db.listSchedules())
  handle(channels.schedulesSave, (input) => db.saveSchedule(input))
  handle(channels.schedulesDelete, (id: string) => {
    db.deleteSchedule(id)
    return { id }
  })
  handle(channels.analyticsGet, () => db.analytics())
  handle(channels.analyticsCsv, () => ({ csv: db.checkoutCsv() }))
  handle(channels.tasksBulk, (input) => {
    const parsed = parseBulkTasks(input)
    const tasks = parsed.tasks.length ? db.createTasks(parsed.tasks) : []
    return { tasks, errors: parsed.errors }
  })
  handle(channels.tasksBulkEdit, (input) => db.bulkEdit(input))
  handle(channels.tasksDuplicate, (ids: string[]) => db.duplicateTasks(ids))
  handle(channels.tasksDeleteMany, (ids: string[]) => db.deleteTasks(ids))
  handle(channels.updatesGet, () => updates.current())
  handle(channels.updatesCheck, () => updates.check())
  handle(channels.updatesDownload, () => updates.download())
  handle(channels.updatesInstall, () => {
    updates.install()
    return { installing: true as const }
  })
  handle(channels.updatesToken, (input: { action: "keep" | "replace" | "clear"; token: string }) => {
    db.setUpdateToken(input.action, input.token ?? "")
    return updates.current()
  })
  handle(channels.templatesList, () => db.listTemplates())
  handle(channels.templatesSave, (input: TaskTemplateInput) => db.saveTemplate(input))
  handle(channels.templatesDelete, (id: string) => {
    db.deleteTemplate(id)
    return { id }
  })
  handle(channels.ordersList, () => db.listOrders())
  handle(channels.imapGet, () => db.imapView())
  handle(channels.imapSave, (input: ImapInput) => db.saveImap(input))
  handle(channels.mailboxesGet, () => db.listMailboxes())
  handle(channels.mailboxSave, (input: MailboxInput) => db.saveMailbox(input))
  handle(channels.mailboxDelete, (id: string) => {
    db.deleteMailbox(id)
    return { id }
  })
  handle(channels.mailboxTest, async (id: string) => {
    const login = db.mailboxSecret(id)
    const lang = db.getSettings().language
    if (!login) throw new AppError(lang === "es" ? "Guarda el buzón y una contraseña de aplicación, o inicia sesión, antes de probar." : "Save the mailbox and an app password, or sign in, before testing.")
    try {
      const cred = await imapCredential(db, login)
      const socket = await openMailbox({ host: login.host, port: login.port, secure: login.secure })
      const folders = await testMailbox(socket, cred)
      db.noteMailbox(id, { ok: true, error: "", folders })
    } catch (err) {
      const raw = err instanceof Error ? err.message : "The connection failed."
      const error = explainMailFailure(raw, login.provider, lang)
      db.noteMailbox(id, { ok: false, error })
      throw new AppError(error)
    }
    const view = db.listMailboxes().find((row) => row.id === id)
    if (!view) throw new AppError("Mailbox not found.")
    return view
  })
  handle(channels.mailboxOAuth, (input: { provider: "gmail" | "outlook"; user: string }) => {
    if (input?.provider !== "gmail" && input?.provider !== "outlook") throw new AppError("Choose Google or Microsoft.")
    return completeMailSignIn(db, { provider: input.provider, user: input?.user ?? "" }, {
      open: (url) => shell.openExternal(url)
    })
  })
  handle(channels.mailOpen, async (url: string) => {
    if (!isMailHelpUrl(url)) throw new AppError(db.getSettings().language === "es" ? "Ese enlace no es una página de configuración del correo." : "That link is not a mail setup page.")
    await shell.openExternal(url)
    return { opened: true as const }
  })
  handle(channels.vaultList, () => db.listVault())
  handle(channels.vaultUnlink, (deviceId: string, accountId: string) => {
    db.unlinkVault(deviceId, accountId)
    return db.listVault()
  })
  handle(channels.vaultTwoWay, (deviceId: string, accountId: string, twoWay: boolean) => {
    db.setVaultTwoWay(deviceId, accountId, twoWay)
    return db.listVault()
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
