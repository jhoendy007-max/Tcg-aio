import { applySolvedCookies, challengePageUrl, classifyChallenge, cookieHeader } from "./challenge"
import type { ChallengeGate } from "./challenge-gate"
import { isBlockStatus as blockStatus, sendWithRecovery, type SessionRefresher } from "./block-recovery"
import { adaptiveDelay, detectChanges, MonitorHub, type WatchSnapshot } from "./monitor"
import { backoffDelay, jitterDelay, PoliteLimiter } from "./polite"
import { storeHome } from "./session-care"
import { activeDropStart, allowCheckout, SpendLimitError } from "./limits"
import { guardTestMode, isFinalSubmit, STAGE_LABEL, type CheckResult, type TestStage } from "./test-mode"
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
  private readonly polite = new PoliteLimiter()
  private readonly hub = new MonitorHub()
  private readonly watches = new Map<string, WatchSnapshot>()

  constructor(
    private readonly db: Database,
    private readonly modules: Map<StoreId, StoreModule>,
    private readonly emit: (event: TaskEvent) => void,
    private readonly notify: (notice: Notice) => Promise<boolean>,
    private readonly http: HttpClient = defaultHttp,
    private readonly challenges?: ChallengeGate,
    private readonly sessionRefresh?: SessionRefresher
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

  /** Persist a stop before the process exits so the next launch does not treat it as a crash. */
  haltAll(): void {
    for (const [id, controller] of this.controllers) {
      controller.abort()
      try {
        const task = this.db.getTask(id)
        if (isActiveStatus(task.status)) {
          this.db.patchTask(id, { status: "stopped", detail: "Stopped", finishedAt: Date.now() })
        }
      } catch {
        // The task was already removed.
      }
    }
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
      const separateMonitor = Boolean(task.monitorProxyGroupId && task.monitorProxyGroupId !== task.proxyGroupId)
      let monitorProxy: ProxyEndpoint | undefined
      let monitorProxies: ProxyEndpoint[] | undefined
      if (separateMonitor && task.monitorProxyGroupId) {
        const group = this.db.getProxyGroup(task.monitorProxyGroupId)
        monitorProxies = group.proxies
        const choice = this.db.assignProxy(`${account.id}:monitor`, group.id, group.proxies)
        monitorProxy = choice.proxy
        const network = group.network === "residential" ? "residential" : "datacenter"
        const detail = !monitorProxy
          ? `Monitor pool ${group.name} is empty. Using a direct connection for stock checks.`
          : `Monitoring through ${network} proxy ${proxyLabel(monitorProxy)} from ${group.name}.`
        update({ log: line("info", detail) })
      }
      if (task.proxyGroupId) {
        const group = this.db.getProxyGroup(task.proxyGroupId)
        proxies = group.proxies
        const choice = this.db.assignProxy(account.id, group.id, group.proxies)
        proxy = choice.proxy
        const network = group.network === "residential" ? "residential" : "datacenter"
        const samePool = !task.monitorProxyGroupId || task.monitorProxyGroupId === task.proxyGroupId
        const detail = !proxy
          ? `Checkout pool ${group.name} is empty. Using a direct connection.`
          : samePool
            ? `Checkout uses the same ${network} pool, ${group.name}.`
            : `Checkout uses ${network} proxy ${proxyLabel(proxy)} from ${group.name}.`
        update({ log: line(choice.allBenched ? "warn" : "info", detail) })
      } else if (!monitorProxy) {
        update({ log: line("info", "Direct connection. No proxy group selected.") })
      }
      if (!monitorProxy) {
        monitorProxy = proxy
        monitorProxies = proxies
      }
      const settings = this.db.getSettings()
      const http = this.polite.wrap(task.store, monitorProxy?.id, this.http, (proxyId, status) => {
        this.db.noteTraffic(task.store, proxyId, status)
      }, controller.signal)
      const checks: string[] = []
      if (testMode) update({ log: line("warn", "TEST MODE. The real flow runs through payment, then stops. The place-order request is not sent.") })
      let handoffs = 0
      const guarded = testMode ? guardTestMode(task.store, http) : http
      const ctx = {
        task: { id: task.id, sku: task.sku, quantity: task.quantity, store: task.store },
        profile,
        account,
        settings,
        proxy: monitorProxy,
        proxies: monitorProxies,
        signal: controller.signal,
        http: guarded,
        testMode,
        clearCartAfterTest: testMode && settings.clearCartAfterTest,
        mark: (stage: TestStage, result: CheckResult, detail: string) => {
          const label = result === "pass" ? "PASS" : result === "fail" ? "FAIL" : "SKIP"
          const message = `${label} ${STAGE_LABEL[stage]} — ${detail}`
          checks.push(message)
          update({ log: line(result === "fail" ? "error" : result === "skip" ? "warn" : "success", message) })
        },
        checklistText: () => checks.join("\n"),
        log: (level: LogLevel, message: string) => update({ log: line(level, message) }),
        detail: (message: string) => update({ detail: redact(message).slice(0, 240) }),
        phase: (status: "monitoring" | "in_stock" | "adding_to_cart" | "checking_out") => {
          update({ status })
          if (status === "monitoring") {
            ctx.proxy = monitorProxy
            ctx.proxies = monitorProxies
          } else {
            ctx.proxy = proxy
            ctx.proxies = proxies
          }
        },
        sleep: (ms: number) => {
          const current = ctx.proxy
          const score = current ? this.db.proxyScores().find((item) => item.proxyId === current.id) : undefined
          const base = ms === settings.monitorDelayMs
            ? adaptiveDelay(task.store, Date.now(), settings, this.db.listSchedules(), Math.random())
            : jitterDelay(ms, settings.monitorJitterPct, Math.random())
          return sleep(base + backoffDelay(score?.streak ?? 0, settings.monitorDelayMs), controller.signal)
        },
        onSession: async (session: FullAccount["session"]) => {
          if (!session) return
          this.db.updateSession(account.id, session)
          account = this.db.readAccount(account.id)
          ctx.account = account
          update({ log: line("info", `Saved the refreshed ${module.displayName} session locally.`) })
        },
        share: <T>(key: string, load: () => Promise<T>) => this.hub.share(key, async () => {
          const started = Date.now()
          const value = await load()
          const status = readStatus(value)
          if (status !== null) this.db.recordMonitor({ store: task.store, ms: Date.now() - started, blocked: blockStatus(status), at: Date.now() })
          return value
        }),
        observe: (snapshot: WatchSnapshot) => {
          const key = `${task.store}:${task.sku}`
          const prev = this.watches.get(key) ?? null
          this.watches.set(key, snapshot)
          if (prev && !prev.purchasable && snapshot.purchasable) {
            this.db.recordRestock({ store: task.store, sku: task.sku, at: Date.now(), price: snapshot.price, title: snapshot.title })
          }
          const messages = detectChanges(prev, snapshot, {
            price: settings.alertPrice,
            offer: settings.alertNewOffer,
            available: settings.alertAvailable,
            retailer: settings.alertRetailer
          })
          for (const message of messages) {
            update({ log: line("info", message) })
            void this.safeNotify(update, {
              kind: "alert",
              storeName: module.displayName,
              sku: task.sku,
              profileName: profile.name,
              detail: message
            })
          }
        },
        refreshSession: this.sessionRefresh
          ? (input: { homeUrl: string; proxy?: ProxyEndpoint; signal: AbortSignal }) => this.sessionRefresh!({
            accountId: account.id,
            store: task.store,
            homeUrl: input.homeUrl,
            proxy: input.proxy,
            existing: account.session,
            signal: input.signal,
            onChallenge: (message) => update({ log: line("warn", message) })
          })
          : undefined
      }
      ctx.http = {
        request: (input) => {
          if (isFinalSubmit(task.store, input)) {
            if (!testMode) {
              const price = this.watches.get(`${task.store}:${task.sku}`)?.price ?? null
              const decision = allowCheckout(this.db.getSettings(), this.db.listCheckouts(), {
                store: task.store,
                sku: task.sku,
                accountId: account.id,
                quantity: task.quantity,
                price,
                now: Date.now(),
                dropStart: activeDropStart(this.db.listSchedules(), Date.now())
              })
              if (!decision.ok) throw new SpendLimitError(decision.reason)
            }
            return guarded.request(input)
          }
          return sendWithRecovery(ctx, input, {
            homeUrl: storeHome(task.store),
            inner: guarded,
            blocked: (response) => blockStatus(response.status, response)
          })
        }
      }
      while (true) {
        const result = await module.run(ctx)
        if (controller.signal.aborted || result.outcome === "stopped") {
          finish(update, "stopped", "Stopped", "info")
          return
        }
        if (result.outcome === "paused" && handoffs < 1 && this.challenges && classifyChallenge(result.reason)) {
          handoffs += 1
          const resumed = await this.handoff(id, controller, update, account, proxy, module.displayName, profile.name, result.reason)
          if (resumed) {
            account = resumed
            ctx.account = resumed
            continue
          }
          return
        }
        await this.finishResult(update, result, task, module.displayName, profile.name)
        return
      }
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        finish(update, "stopped", "Stopped", "info")
        return
      }
      if (err instanceof SpendLimitError) {
        finish(update, "paused", err.message, "warn")
        await this.safeNotify(update, {
          kind: "paused",
          storeName: module.displayName,
          sku: task.sku,
          profileName: profileName(),
          detail: err.message
        })
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
    task: { store: StoreId; sku: string; accountId: string; profileId: string; quantity: number },
    storeNameText: string,
    profileNameText: string
  ): Promise<void> {
    const sku = task.sku
    if (result.outcome === "success") {
      finish(update, "success", result.detail, "success")
      this.remember(task, "success", profileNameText, result.detail, result.orderId)
      if (result.orderId) {
        this.db.rememberOrder({
          at: Date.now(),
          store: task.store,
          sku: task.sku,
          orderId: result.orderId,
          accountId: task.accountId,
          profileId: task.profileId,
          quantity: task.quantity,
          detail: result.detail
        })
      }
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
      this.remember(task, "tested", profileNameText, result.detail)
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
      this.remember(task, "paused", profileNameText, result.reason)
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
    this.remember(task, "failure", profileNameText, result.reason)
    await this.safeNotify(update, {
      kind: "failure",
      storeName: storeNameText,
      sku,
      profileName: profileNameText,
      detail: result.reason
    })
  }

  private remember(task: { store: StoreId; sku: string; accountId: string; profileId: string; quantity: number }, outcome: "success" | "failure" | "paused" | "tested", profileName: string, detail: string, orderId?: string): void {
    this.db.recordCheckout({
      store: task.store,
      sku: task.sku,
      product: task.sku,
      outcome,
      profileName,
      detail,
      orderId,
      accountId: task.accountId,
      profileId: task.profileId,
      quantity: task.quantity
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

function readStatus(value: unknown): number | null {
  if (!value || typeof value !== "object") return null
  if ("status" in value && typeof value.status === "number") return value.status
  if ("value" in value && value.value && typeof value.value === "object" && "status" in value.value && typeof value.value.status === "number") {
    return value.value.status
  }
  return null
}

function line(level: LogLevel, message: string) {
  return { ts: Date.now(), level, message: redact(message).slice(0, 500) }
}

