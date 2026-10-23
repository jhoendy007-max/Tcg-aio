import { hostname } from "node:os"
import type { AlertService } from "../engine/alerts"
import { mintRelayDevice, provisionHostedRelay, revokeRelayDevice } from "./hosted-relay"
import { DEFAULT_LICENSE_SERVER_URL } from "../shared/types"
import { checkStoreHealth } from "../engine/health"
import { defaultHttp, type HttpClient } from "../engine/http"
import type { Database } from "../engine/database"
import type { TaskService } from "../engine/task-runner"
import { STORE_CATALOG, storeName } from "../shared/stores"
import type { KeywordWatchInput, RestockRuleInput } from "../shared/types"
import { parseBulkTasks } from "../engine/bulk"
import { completeMailSignIn, mailClientId } from "../engine/mail-oauth"
import { detectMailbox, MAIL_PRESETS } from "../shared/mail"
import { applyPhoneSettings, projectPhoneClient, projectPhoneLedger, projectPhoneSettings, quickTasks, type PhoneAccountDraft, type PhoneClientDraft, type PhoneProfileDraft, type PhoneProxyDraft, type PhoneQuickDraft, type PhoneSettingsDraft } from "./desk"
import { EMPTY_ALERTS, projectAccount, projectProfile, projectProxyGroup, projectTask, type PhoneAlerts, type PhoneAnalytics, type PhoneChallenge, type PhoneKeeper, type PhoneMailDraft, type PhoneSchedule, type PhoneSnapshot, type PhoneTaskDraft, type PhoneUpdates } from "./protocol"
import type { PhoneHost } from "./server"

export function desktopName(): string {
  return hostname().slice(0, 60) || "Zzz AIO"
}

export interface PhoneChallengeActions {
  open(): Promise<void> | void
  complete(): Promise<void> | void
  dismiss(): void
  submit(cookie: string): void
  current(): PhoneChallenge | null
}

export function createPhoneHost(
  db: Database,
  getRunner: () => TaskService | null,
  getAlerts: () => AlertService | null = () => null,
  challenge?: PhoneChallengeActions,
  session?: { open(accountId: string): Promise<void> | void; warm?(accountId: string): Promise<{ expired: boolean; detail: string }> },
  openUrl?: (url: string) => Promise<void> | void,
  http: HttpClient = defaultHttp
): PhoneHost {
  const pcName = desktopName()
  const snapshot = (): PhoneSnapshot => {
    const profiles = db.listProfiles()
    const accounts = db.listAccounts()
    const groups = db.listProxyGroups()
    const settings = db.getSettings()
    return {
      pcName,
      testMode: settings.testMode,
      clearCartAfterTest: settings.clearCartAfterTest,
      tasks: db.listTasks().map((task) => projectTask(task, profiles, accounts, groups)),
      profiles: profiles.map(projectProfile),
      accounts: accounts.map(projectAccount),
      proxyGroups: groups.map(projectProxyGroup),
      stores: STORE_CATALOG,
      alerts: alerts(),
      schedules: schedules(),
      analytics: analytics(),
      updates: updates(),
      keeper: keeper(),
      imap: {
        ...db.mailboxStatus(),
        mailboxes: db.listMailboxes().map((row) => ({
          id: row.id,
          name: row.name,
          user: row.user,
          provider: row.provider,
          host: row.host,
          port: row.port,
          secure: row.secure,
          mailbox: row.mailbox,
          enabled: row.enabled,
          auth: row.auth,
          orders: row.orders,
          alerts: row.alerts,
          codes: row.codes,
          lastError: row.lastError
        })),
        googleSignIn: Boolean(mailClientId("gmail", settings)),
        microsoftSignIn: Boolean(mailClientId("outlook", settings))
      },
      language: settings.language === "es" ? "es" : "en",
      modules: settings.modules,
      moduleGlobals: {
        monitorDelayMs: settings.monitorDelayMs,
        sessionWarmupMin: settings.sessionWarmupMin,
        blockRetries: settings.blockRetries,
        testMode: settings.testMode,
        monitorZips: settings.monitorZips,
        monitorStoreIds: settings.monitorStoreIds,
        targetZip: settings.targetZip,
        targetStoreId: settings.targetStoreId
      },
      autopilot: settings.autopilot,
      brand: {
        appName: !settings.appName || /^tcg[\s-]?aio$/i.test(settings.appName) ? "Zzz AIO" : settings.appName,
        theme: settings.theme,
        accent: settings.accent,
        successSound: settings.successSound,
        sounds: { on: settings.soundsOn !== false, instock: settings.soundInStock ?? "rise", success: settings.soundSuccess ?? "fanfare", failure: settings.soundFailure ?? "drop" }
      },
      clients: db.listClients().map(projectPhoneClient),
      ledger: db.listLedger().slice(0, 80).map(projectPhoneLedger),
      desk: projectPhoneSettings(settings),
      licenseOk: db.licenseAllows(),
      accountPending: db.accountView().pending,
      storeRoles: settings.storeRoles ?? {}
    }
  }
  const schedules = (): PhoneSchedule[] => db.listSchedules().map((schedule) => ({
    id: schedule.id,
    name: schedule.name,
    enabled: schedule.enabled,
    startAt: schedule.startAt,
    stopAt: schedule.stopAt,
    warmupMin: schedule.warmupMin,
    phase: schedule.phase,
    taskCount: schedule.taskIds.length,
    group: schedule.group
  }))
  const analytics = (): PhoneAnalytics => {
    const report = db.analytics()
    return {
      attempts: report.attempts,
      success: report.success,
      failure: report.failure,
      paused: report.paused,
      tested: report.tested,
      winRate: report.winRate,
      spend: report.spend,
      byStore: report.byStore.map((row) => ({ store: row.store, storeName: row.storeName, success: row.success, failure: row.failure, paused: row.paused, spend: row.spend })),
      recent: report.recent.slice(0, 40).map((row) => ({ at: row.at, storeName: storeName(row.store), sku: row.sku, outcome: row.outcome, price: row.price })),
      monitorSamples: report.monitor.samples,
      monitorBlocked: report.monitor.blocked,
      monitorBlockRate: report.monitor.blockRate,
      monitorAvgMs: report.monitor.avgMs,
      monitorP50Ms: report.monitor.p50Ms,
      monitorP95Ms: report.monitor.p95Ms
    }
  }
  const updates = (): PhoneUpdates => db.updateNotice()
  const keeper = (): PhoneKeeper => {
    const settings = db.getSettings()
    const accounts = db.listAccounts()
    return {
      enabled: settings.sessionWarmup,
      intervalMin: settings.sessionWarmupMin,
      saved: accounts.filter((account) => account.sessionState === "saved").length,
      expired: accounts.filter((account) => account.sessionState === "expired").length
    }
  }
  const alerts = (): PhoneAlerts => getAlerts()?.phoneAlerts() ?? EMPTY_ALERTS
  const changed = (): PhoneAlerts => {
    getAlerts()?.refresh()
    return alerts()
  }
  return {
    pcId: db.pcId(),
    pcName,
    relayUrl: () => db.getSettings().phoneRelayUrl,
    canResumeRelay: () => Boolean(db.readPhoneRelay() && db.sessionToken()),
    log: (line: string) => console.info(line),
    async provisionRelay() {
      const sessionToken = db.sessionToken()
      if (!sessionToken) throw new Error("Sign in on this PC before pairing a phone.")
      const licenseUrl = db.getSettings().licenseServerUrl.trim() || DEFAULT_LICENSE_SERVER_URL
      const saved = db.readPhoneRelay()
      const hosted = await provisionHostedRelay({ licenseUrl, sessionToken, saved })
      if (!saved || saved.channel !== hosted.channel || saved.token !== hosted.pcToken) {
        db.savePhoneRelay({ channel: hosted.channel, token: hosted.pcToken })
      }
      return hosted
    },
    async issueRelayDevice(deviceId: string) {
      const sessionToken = db.sessionToken()
      if (!sessionToken) return undefined
      const licenseUrl = db.getSettings().licenseServerUrl.trim() || DEFAULT_LICENSE_SERVER_URL
      return mintRelayDevice({ licenseUrl, sessionToken, deviceId })
    },
    async revokeRelayDevice(deviceId: string) {
      const sessionToken = db.sessionToken()
      if (!sessionToken) return
      const licenseUrl = db.getSettings().licenseServerUrl.trim() || DEFAULT_LICENSE_SERVER_URL
      await revokeRelayDevice({ licenseUrl, sessionToken, deviceId })
    },
    snapshot,
    saveTask(draft: PhoneTaskDraft) {
      const saved = db.saveTask(draft)
      return projectTask(saved, db.listProfiles(), db.listAccounts(), db.listProxyGroups())
    },
    deleteTask(id: string) {
      if (getRunner()?.isRunning(id)) throw new Error("Stop the task before deleting it.")
      db.deleteTask(id)
    },
    start(id: string, options?: { test?: boolean }) {
      if (!db.licenseAllows()) throw new Error(db.accountView().pending ? "This PC is waiting for activation." : "This PC is not activated. Add a license key in Settings.")
      const runner = getRunner()
      if (!runner) throw new Error("The desktop app is still starting.")
      runner.start(id, options)
    },
    async checkHealth(proxyGroupId: string | null) {
      const proxies = proxyGroupId ? db.getProxyGroup(proxyGroupId).proxies : []
      return db.recordHealth(await checkStoreHealth(http, proxies), proxies)
    },
    stop(id: string) {
      getRunner()?.stop(id)
    },
    startAll() {
      if (!db.licenseAllows()) throw new Error(db.accountView().pending ? "This PC is waiting for activation." : "This PC is not activated. Add a license key in Settings.")
      const runner = getRunner()
      if (!runner) throw new Error("The desktop app is still starting.")
      return runner.startAll()
    },
    stopAll() {
      getRunner()?.stopAll()
    },
    pauseAll() {
      getRunner()?.stopAll()
    },
    setAutopilot(enabled: boolean) {
      const settings = db.getSettings()
      db.saveSettings({ ...settings, autopilot: enabled })
    },
    setLanguage(language: "en" | "es") {
      db.saveSettings({ ...db.getSettings(), language })
    },
    saveMailbox(input: PhoneMailDraft) {
      const detected = detectMailbox(input.user)
      const provider = input.provider === "custom" && detected && !detected.guessed ? detected.provider : input.provider
      const preset = provider === "gmail" || provider === "outlook" || provider === "icloud" || provider === "yahoo" ? MAIL_PRESETS[provider] : null
      db.saveMailbox({
        id: input.id,
        name: input.user,
        enabled: true,
        provider,
        host: input.host || preset?.host || detected?.host || "",
        port: input.port || preset?.port || detected?.port || 993,
        secure: input.secure,
        user: input.user,
        mailbox: input.mailbox || "INBOX",
        password: input.password,
        passwordAction: input.password ? "replace" : "keep",
        orders: input.orders,
        alerts: input.alerts,
        codes: input.codes
      })
    },
    deleteMailbox(id: string) {
      db.deleteMailbox(id)
    },
    async     signInMail(input: { provider: "gmail" | "outlook"; user: string }) {
      const open = openUrl
      if (!open) throw new Error("Sign-in can only start from the desktop app.")
      await completeMailSignIn(db, input, { open })
    },
    saveModule(store, record) {
      db.saveModule(store, record)
    },
    resetModule(store) {
      db.resetModule(store)
    },
    importModule(text) {
      db.importModule(text)
    },
    devices: () => db.listDevices(),
    deviceTokens: () => db.deviceTokens(),
    saveDevice: (device) => db.saveDevice(device),
    revokeDevice: (id) => db.revokeDevice(id),
    touchDevice: (id) => db.touchDevice(id),
    alerts,
    saveRule(input: RestockRuleInput) {
      db.saveRestockRule(input)
      return changed()
    },
    deleteRule(id: string) {
      db.deleteRestockRule(id)
      return changed()
    },
    toggleRule(id: string, enabled: boolean) {
      const rule = db.listRestockRules().find((item) => item.id === id)
      if (!rule) throw new Error("That restock rule was not found.")
      db.saveRestockRule({ ...rule, enabled })
      return changed()
    },
    saveWatch(input: KeywordWatchInput) {
      db.saveWatch(input)
      return changed()
    },
    deleteWatch(id: string) {
      db.deleteWatch(id)
      return changed()
    },
    toggleWatch(id: string, enabled: boolean) {
      const watch = db.listWatches().find((item) => item.id === id)
      if (!watch) throw new Error("That keyword watch was not found.")
      db.saveWatch({ ...watch, enabled, maxPrice: watch.maxPrice })
      return changed()
    },
    resumeWatch(id: string) {
      db.resumeWatch(id)
      return changed()
    },
    openChallenge() {
      if (!challenge) throw new Error("Challenge handoff is not available.")
      return challenge.open()
    },
    completeChallenge() {
      if (!challenge) throw new Error("Challenge handoff is not available.")
      return challenge.complete()
    },
    dismissChallenge() {
      if (!challenge) throw new Error("Challenge handoff is not available.")
      challenge.dismiss()
    },
    submitChallenge(cookie: string) {
      if (!challenge) throw new Error("Challenge handoff is not available.")
      challenge.submit(cookie)
    },
    currentChallenge() {
      return challenge?.current() ?? null
    },
    openAccountLogin(id: string) {
      if (!session) throw new Error("Browser sign-in is not available.")
      return session.open(id)
    },
    bulkTasks(input: { text: string; store: PhoneTaskDraft["store"]; quantity: number; profileId: string; accountId: string; proxyGroupId: string | null; confirmPurchase: boolean; testMode: boolean; group: string }) {
      const parsed = parseBulkTasks({
        store: input.store,
        quantity: input.quantity,
        profileId: input.profileId,
        accountId: input.accountId,
        proxyGroupId: input.proxyGroupId,
        confirmPurchase: input.confirmPurchase,
        testMode: input.testMode === true,
        group: input.group,
        text: input.text
      })
      if (!parsed.tasks.length) throw new Error(parsed.errors[0] ?? "No tasks were created.")
      const created = db.createTasks(parsed.tasks)
      return { created: created.length, errors: parsed.errors.map((error) => ({ id: "", error })) }
    },
    duplicateTask(id: string) {
      const [copy] = db.duplicateTasks([id])
      if (!copy) throw new Error("Task not found.")
      return projectTask(copy, db.listProfiles(), db.listAccounts(), db.listProxyGroups())
    },
    saveSchedule(input: { name: string; startAt: string; stopAt: string; warmupMin: number; group: string; taskIds: string[] }) {
      db.saveSchedule({
        name: input.name,
        enabled: true,
        startAt: input.startAt,
        stopAt: input.stopAt || null,
        warmupMin: input.warmupMin,
        taskIds: input.taskIds,
        group: input.group
      })
    },
    deleteSchedule(id: string) {
      db.deleteSchedule(id)
    },
    analyticsCsv() {
      return db.checkoutCsv()
    },
    linkVault(deviceId: string, accountId: string, twoWay: boolean) {
      db.linkVault(deviceId, accountId, twoWay)
    },
    unlinkVault(deviceId: string, accountId: string) {
      db.unlinkVault(deviceId, accountId)
    },
    pushVault(deviceId: string, accountId: string, cookie: string, expiresAt: number | null) {
      db.pushVault(deviceId, accountId, cookie, expiresAt)
    },
    pullVault(deviceId: string, accountId: string) {
      return db.pullVault(deviceId, accountId)
    },
    twoWayDevices(accountId: string) {
      return db.vaultLinksFor(accountId, true).map((link) => link.deviceId)
    },
    saveProfile(input: PhoneProfileDraft) {
      db.saveProfile(input)
    },
    deleteProfile(id: string) {
      db.deleteProfile(id)
    },
    saveAccount(input: PhoneAccountDraft) {
      db.saveAccount({ ...input, session: "", sessionAction: "keep" })
    },
    deleteAccount(id: string) {
      db.deleteAccount(id)
    },
    async warmAccount(id: string) {
      if (!session?.warm) throw new Error("Session warm-up runs on the PC.")
      return session.warm(id)
    },
    saveProxy(input: PhoneProxyDraft) {
      db.saveProxyGroup(input)
    },
    deleteProxy(id: string) {
      db.deleteProxyGroup(id)
    },
    saveClient(input: PhoneClientDraft) {
      db.saveClient(input)
    },
    deleteClient(id: string) {
      db.deleteClient(id)
    },
    markLedger(clientId: string, ids: string[], paid: boolean) {
      db.markLedgerPaid(clientId, ids, paid)
    },
    ledgerCsv(clientId?: string) {
      return db.ledgerExport(clientId)
    },
    saveDeskSettings(input: PhoneSettingsDraft) {
      db.saveSettings(applyPhoneSettings(db.getSettings(), input))
    },
    quickSetup(input: PhoneQuickDraft) {
      const pair = quickTasks(input)
      const monitor = db.saveTask(pair.monitor)
      db.saveTask({ ...pair.checkout, linkedMonitorId: monitor.id })
      return { created: 2 }
    }
  }
}
