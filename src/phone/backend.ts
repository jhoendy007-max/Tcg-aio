import { hostname } from "node:os"
import type { AlertService } from "../engine/alerts"
import { checkStoreHealth } from "../engine/health"
import { defaultHttp } from "../engine/http"
import type { Database } from "../engine/database"
import type { TaskService } from "../engine/task-runner"
import { STORE_CATALOG } from "../shared/stores"
import type { KeywordWatchInput, RestockRuleInput } from "../shared/types"
import { EMPTY_ALERTS, projectAccount, projectProfile, projectProxyGroup, projectTask, type PhoneAlerts, type PhoneSnapshot, type PhoneTaskDraft } from "./protocol"
import type { PhoneHost } from "./server"

export function desktopName(): string {
  return hostname().slice(0, 60) || "TCGAIO"
}

export function createPhoneHost(db: Database, getRunner: () => TaskService | null, getAlerts: () => AlertService | null = () => null): PhoneHost {
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
      alerts: alerts()
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
      return checkStoreHealth(defaultHttp, proxies)
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
    }
  }
}
