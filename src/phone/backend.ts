import { hostname } from "node:os"
import type { AlertService } from "../engine/alerts"
import { checkStoreHealth } from "../engine/health"
import { defaultHttp } from "../engine/http"
import type { Database } from "../engine/database"
import type { TaskService } from "../engine/task-runner"
import { STORE_CATALOG, storeName } from "../shared/stores"
import type { KeywordWatchInput, RestockRuleInput } from "../shared/types"
import { parseBulkTasks } from "../engine/bulk"
import { EMPTY_ALERTS, projectAccount, projectProfile, projectProxyGroup, projectTask, type PhoneAlerts, type PhoneAnalytics, type PhoneChallenge, type PhoneKeeper, type PhoneSchedule, type PhoneSnapshot, type PhoneTaskDraft, type PhoneUpdates } from "./protocol"
import type { PhoneHost } from "./server"

export function desktopName(): string {
  return hostname().slice(0, 60) || "TCGAIO"
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
  session?: { open(accountId: string): Promise<void> | void }
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
      keeper: keeper()
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
      recent: report.recent.slice(0, 8).map((row) => ({ at: row.at, storeName: storeName(row.store), sku: row.sku, outcome: row.outcome, price: row.price })),
      monitorSamples: report.monitor.samples,
      monitorBlocked: report.monitor.blocked,
      monitorBlockRate: report.monitor.blockRate,
      monitorAvgMs: report.monitor.avgMs
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
      const runner = getRunner()
      if (!runner) throw new Error("The desktop app is still starting.")
      runner.start(id, options)
    },
    async checkHealth(proxyGroupId: string | null) {
      const proxies = proxyGroupId ? db.getProxyGroup(proxyGroupId).proxies : []
      return db.recordHealth(await checkStoreHealth(defaultHttp, proxies), proxies)
    },
    stop(id: string) {
      getRunner()?.stop(id)
    },
    startAll() {
      const runner = getRunner()
      if (!runner) throw new Error("The desktop app is still starting.")
      return runner.startAll()
    },
    stopAll() {
      getRunner()?.stopAll()
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
    }
  }
}
