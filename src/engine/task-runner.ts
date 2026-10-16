import { applySolvedCookies, challengePageUrl, classifyChallenge, cookieHeader } from "./challenge"
import type { ChallengeGate } from "./challenge-gate"
import { guardTestMode, STAGE_LABEL, type CheckResult, type TestStage } from "./test-mode"
import { proxyLabel } from "../shared/proxy"
import { redact } from "../shared/redact"
import { isAbortError, sleep } from "./sleep"
import type { Database } from "./database"
import { defaultHttp, type HttpClient } from "./http"
import type { StoreModule, StoreRunResult } from "../stores/module"
import { isActiveStatus, type FullAccount, type LogLevel, type Notice, type ProxyEndpoint, type StoreId, type TaskEvent, type TaskStatus } from "../shared/types"

export class TaskService {
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly db: Database,
    private readonly modules: Map<StoreId, StoreModule>,
    private readonly emit: (event: TaskEvent) => void,
    private readonly notify: (notice: Notice) => Promise<boolean>,
    private readonly http: HttpClient = defaultHttp,
    private readonly challenges?: ChallengeGate
  ) {}

  isRunning(id: string): boolean {
    return this.inflight.has(id)
  }

  start(id: string, options?: { test?: boolean }): void {
    if (this.inflight.has(id)) return
    const task = this.db.getTask(id)
    const testMode = options?.test === true || task.testMode === true || this.db.getSettings().testMode === true
    if (!testMode && !task.confirmPurchase) {
      throw new Error("Confirm that this task may place a real shipping order before starting it.")
    }
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const promise = this.execute(id, controller, testMode).finally(() => {
      this.inflight.delete(id)
      this.controllers.delete(id)
    })
    this.inflight.set(id, promise)
  }

  wait(id: string): Promise<void> {
    return this.inflight.get(id) ?? Promise.resolve()
  }

  stop(id: string): void {
    this.controllers.get(id)?.abort()
  }

  stopAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
  }

  startAll(): { started: string[]; errors: { id: string; error: string }[] } {
    const started: string[] = []
    const errors: { id: string; error: string }[] = []
    for (const task of this.db.listTasks()) {
      if (this.isRunning(task.id) || isActiveStatus(task.status)) continue
      try {
        this.start(task.id)
        started.push(task.id)
      } catch (err) {
        errors.push({ id: task.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { started, errors }
  }

  private async execute(id: string, controller: AbortController, testMode: boolean): Promise<void> {
    const task = this.db.getTask(id)
    const module = this.modules.get(task.store)
    const profileName = () => {
      try {
        return this.db.readProfile(task.profileId).name
      } catch {
        return "Profile"
      }
    }
    const update = (patch: Parameters<Database["patchTask"]>[1]) => {
      const next = this.db.patchTask(id, patch)
      this.emit({ type: "upsert", task: next })
      return next
    }
    if (!module) {
      update({
        status: "failed",
        detail: "That store is not registered.",
        finishedAt: Date.now(),
        log: line("error", "That store is not registered.")
      })
      return
    }
    update({
      status: "monitoring",
      detail: "Starting",
      startedAt: Date.now(),
      finishedAt: undefined,
      log: line("info", "Task started.")
    })
    let proxy: ProxyEndpoint | undefined
    let proxies: ProxyEndpoint[] | undefined
    try {
      const profile = this.db.readProfile(task.profileId)
      let account = this.db.readAccount(task.accountId)
      if (task.proxyGroupId) {
        const group = this.db.getProxyGroup(task.proxyGroupId)
        proxies = group.proxies
        proxy = pickProxy(group.proxies, task.id)
        update({
          log: line("info", proxy ? `Using proxy ${proxyLabel(proxy)} from ${group.name}.` : `Proxy group ${group.name} is empty. Using a direct connection.`)
        })
      } else {
        update({ log: line("info", "Direct connection. No proxy group selected.") })
      }
      const settings = this.db.getSettings()
      const checks: string[] = []
      if (testMode) update({ log: line("warn", "TEST MODE. The real flow runs through payment, then stops. The place-order request is not sent.") })
      let handoffs = 0
      while (true) {
        const result = await module.run({
          task: { id: task.id, sku: task.sku, quantity: task.quantity, store: task.store },
          profile,
          account,
          settings,
          proxy,
          proxies,
          signal: controller.signal,
          http: testMode ? guardTestMode(task.store, this.http) : this.http,
          testMode,
          clearCartAfterTest: testMode && settings.clearCartAfterTest,
          mark: (stage: TestStage, result: CheckResult, detail: string) => {
            const label = result === "pass" ? "PASS" : result === "fail" ? "FAIL" : "SKIP"
            const message = `${label} ${STAGE_LABEL[stage]} — ${detail}`
            checks.push(message)
            update({ log: line(result === "fail" ? "error" : result === "skip" ? "warn" : "success", message) })
          },
          checklistText: () => checks.join("\n"),
          log: (level, message) => update({ log: line(level, message) }),
          detail: (message) => update({ detail: redact(message).slice(0, 240) }),
          phase: (status) => update({ status }),
          sleep: (ms) => sleep(ms, controller.signal),
          onSession: async (session) => {
            this.db.updateSession(account.id, session)
            account = this.db.readAccount(account.id)
            update({ log: line("info", `Saved the refreshed ${module.displayName} session locally.`) })
          }
        })
        if (controller.signal.aborted || result.outcome === "stopped") {
          finish(update, "stopped", "Stopped", "info")
          return
        }
        if (result.outcome === "paused" && handoffs < 1 && this.challenges && classifyChallenge(result.reason)) {
          handoffs += 1
          const resumed = await this.handoff(id, controller, update, account, proxy, module.displayName, profile.name, result.reason)
          if (resumed) {
            account = resumed
            continue
          }
          return
        }
        await this.finishResult(update, result, module.displayName, task.sku, profile.name)
        return
      }
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        finish(update, "stopped", "Stopped", "info")
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      finish(update, "failed", message, "error")
      await this.safeNotify(update, {
        kind: "failure",
        storeName: module.displayName,
        sku: task.sku,
        profileName: profileName(),
        detail: message
      })
    }
  }

  private async handoff(
    id: string,
    controller: AbortController,
    update: (patch: Parameters<Database["patchTask"]>[1]) => void,
    account: FullAccount,
    proxy: ProxyEndpoint | undefined,
    storeNameText: string,
    profileNameText: string,
    reason: string
  ): Promise<FullAccount | null> {
    const gate = this.challenges
    if (!gate) return null
    const task = this.db.getTask(id)
    const timeout = this.db.getSettings().challengeTimeoutSec
    update({
      status: "challenge",
      detail: `Waiting for a person to solve the challenge (${timeout}s).`,
      finishedAt: undefined,
      log: line("warn", reason)
    })
    await this.safeNotify(update, {
      kind: "challenge",
      storeName: storeNameText,
      sku: task.sku,
      profileName: profileNameText,
      detail: reason
    })
    const outcome = await gate.wait({
      taskId: id,
      store: task.store,
      storeName: storeNameText,
      sku: task.sku,
      url: challengePageUrl(task.store, task.sku),
      reason,
      proxyLabel: proxy ? proxyLabel(proxy) : "Direct",
      cookie: cookieHeader(account.session),
      session: account.session,
      proxy
    }, controller.signal, timeout)
    if (controller.signal.aborted || outcome.kind === "aborted") {
      finish(update, "stopped", "Stopped", "info")
      return null
    }
    if (outcome.kind === "solved") {
      this.db.updateSession(account.id, applySolvedCookies(account.session, outcome.cookies))
      update({
        status: "monitoring",
        detail: "Challenge solved. Resuming.",
        finishedAt: undefined,
        log: line("success", "Saved the solved cookies and resumed the task.")
      })
      return this.db.readAccount(account.id)
    }
    const detail = outcome.kind === "timeout"
      ? `Challenge timed out after ${timeout}s. ${reason}`
      : outcome.kind === "busy"
        ? `Another challenge is already open. ${reason}`
        : reason
    finish(update, "paused", detail, "warn")
    await this.safeNotify(update, {
      kind: "paused",
      storeName: storeNameText,
      sku: task.sku,
      profileName: profileNameText,
      detail
    })
    return null
  }

  private async finishResult(
    update: (patch: Parameters<Database["patchTask"]>[1]) => void,
    result: StoreRunResult,
    storeNameText: string,
    sku: string,
    profileNameText: string
  ): Promise<void> {
    if (result.outcome === "success") {
      finish(update, "success", result.detail, "success")
      await this.safeNotify(update, {
        kind: "success",
        storeName: storeNameText,
        sku,
        profileName: profileNameText,
        detail: result.detail,
        orderId: result.orderId
      })
      return
    }
    if (result.outcome === "tested") {
      finish(update, "tested", "Test passed. Place order was not sent.", "success")
      await this.safeNotify(update, {
        kind: "tested",
        storeName: storeNameText,
        sku,
        profileName: profileNameText,
        detail: result.detail
      })
      return
    }
    if (result.outcome === "paused") {
      finish(update, "paused", result.reason, "warn")
      await this.safeNotify(update, {
        kind: "paused",
        storeName: storeNameText,
        sku,
        profileName: profileNameText,
        detail: result.reason
      })
      return
    }
    if (result.outcome === "stopped") {
      finish(update, "stopped", "Stopped", "info")
      return
    }
    finish(update, "failed", result.reason, "error")
    await this.safeNotify(update, {
      kind: "failure",
      storeName: storeNameText,
      sku,
      profileName: profileNameText,
      detail: result.reason
    })
  }

  private async safeNotify(update: (patch: Parameters<Database["patchTask"]>[1]) => void, notice: Notice): Promise<void> {
    try {
      const delivered = await this.notify(notice)
      update({ log: line("info", delivered ? "Discord notification sent." : "Discord webhook is not set.") })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      update({ log: line("warn", `Discord notification failed: ${message}`) })
    }
  }
}

function finish(
  update: (patch: Parameters<Database["patchTask"]>[1]) => void,
  status: TaskStatus,
  detail: string,
  level?: LogLevel
): void {
  update({
    status,
    detail: redact(detail).slice(0, 240),
    finishedAt: Date.now(),
    log: level ? line(level, detail) : undefined
  })
}

function line(level: LogLevel, message: string) {
  return { ts: Date.now(), level, message: redact(message).slice(0, 500) }
}

function pickProxy(proxies: ProxyEndpoint[], taskId: string): ProxyEndpoint | undefined {
  if (!proxies.length) return undefined
  let hash = 0
  for (const char of taskId) hash = (hash + char.charCodeAt(0)) >>> 0
  return proxies[hash % proxies.length]
}
