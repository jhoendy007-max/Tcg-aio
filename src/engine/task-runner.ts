import { applySolvedCookies, challengePageUrl, classifyChallenge, cookieHeader } from "./challenge"
import type { ChallengeGate } from "./challenge-gate"
import { isBlockStatus as blockStatus, sendWithRecovery, SINGLE_PROXY_WARNING, type SessionRefresher } from "./block-recovery"
import { classifyTraffic, pollQueue } from "./traffic"
import { plainNetworkError } from "./chromium-session"
import { adaptiveDelay, detectChanges, MonitorHub, stockCheckLine, type WatchSnapshot } from "./monitor"
import type { RequestTiming } from "./http"
import { productImage } from "../shared/image"
import { cleanImageUrl } from "./validate"
import { postDiscord } from "./discord"
import { noticeAllowed, StockAlerts, stockKey } from "./stock-alerts"
import { clientCanStart, clientIdOf, clientSuccessNotice } from "../shared/clients"
import { isCardDecline, issueText } from "../shared/checkout-health"
import { moduleScope, resolveModule, resolvedValues, type ModulePace } from "../shared/module-settings"
import { overridesWithStoreRole } from "../shared/store-defaults"
import { checkoutsToStart, triggerDecision } from "../shared/task-role"
import { accountPartition } from "../shared/consistency"
import { backoffDelay, jitterDelay, perProxyFloorMs, perProxyPaceLine, PoliteLimiter } from "./polite"
import { accountsToWarm, storeHome } from "./session-care"
import { activeDropStart, allowCheckout, SpendLimitError } from "./limits"
import { guardTestMode, isFinalSubmit, STAGE_LABEL, type CheckResult, type TestStage } from "./test-mode"
import { proxyLabel } from "../shared/proxy"
import { redact } from "../shared/redact"
import { isAbortError, sleep } from "./sleep"
import type { Database } from "./database"
import { defaultHttp, type HttpClient } from "./http"
import type { StoreModule, StoreRunResult } from "../stores/module"
import { isActiveStatus, type FullAccount, type FullProfile, type LogLevel, type Notice, type ProxyEndpoint, type PublicTask, type Settings, type StoreId, type TaskEvent, type TaskStatus } from "../shared/types"

export class TaskService {
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly polite = new PoliteLimiter()
  private readonly hub = new MonitorHub()
  private readonly watches = new Map<string, WatchSnapshot>()
  private readonly stockAlerts = new StockAlerts(() => Math.max(0, Number(this.db.getSettings().notifyCooldownMin ?? 10)) * 60_000)
  private readonly blockNotes = new Map<string, number>()

  constructor(
    private readonly db: Database,
    private readonly modules: Map<StoreId, StoreModule>,
    private readonly emit: (event: TaskEvent) => void,
    private readonly notify: (notice: Notice) => Promise<boolean>,
    private readonly http: HttpClient = defaultHttp,
    private readonly challenges?: ChallengeGate,
    private readonly sessionRefresh?: SessionRefresher,
    private readonly readCode?: (store: StoreId) => Promise<string | null>,
    private readonly warmAccount?: (accountId: string) => Promise<void>
  ) {}

  isRunning(id: string): boolean {
    return this.inflight.has(id)
  }

  validateStart(id: string): void {
    const task = this.db.getTask(id)
    if (task.kind === "monitor" || task.monitorOnly === true) return
    if (!task.profileId) throw new Error("Choose a saved profile before starting this task.")
    if (!task.accountId) throw new Error("Choose a saved account before starting this task.")
    try {
      this.db.readProfile(task.profileId)
    } catch {
      throw new Error("Choose a saved profile before starting this task.")
    }
    try {
      this.db.readAccount(task.accountId)
    } catch {
      throw new Error("Choose a saved account before starting this task.")
    }
  }

  start(id: string, options?: { test?: boolean }): void {
    if (this.inflight.has(id)) return
    if (!this.db.licenseAllows()) throw new Error(this.db.accountView().pending ? "This PC is waiting for activation." : "This PC is not activated. Add a license key in Settings.")
    const task = this.db.getTask(id)
    this.validateStart(id)
    const client = this.db.clientById(clientIdOf(task.clientId))
    if (client && !clientCanStart(client.status)) {
      throw new Error("This client is paused. Set the client back to active before starting tasks.")
    }
    const testMode = options?.test === true || task.testMode === true || this.db.getSettings().testMode === true
    if (!testMode && !task.confirmPurchase && task.monitorOnly !== true && task.kind !== "monitor") {
      throw new Error("Confirm that this task may place a real shipping order before starting it.")
    }
    if (task.kind !== "monitor" && task.monitorOnly !== true) {
      const report = this.db.assessTask(id)
      const lang = this.db.getSettings().language === "es" ? "es" : "en"
      if (report.blocked) {
        const message = report.issues.filter((item) => item.level === "block").map((item) => issueText(lang, item)).join(" ")
        void this.notify({
          kind: "paused",
          storeName: task.store,
          sku: task.sku,
          profileName: client?.name || "Checkout",
          detail: message
        }).catch(() => undefined)
        throw new Error(message)
      }
      if (report.issues.length) {
        this.db.patchTask(id, {
          log: line("warn", report.issues.map((item) => issueText(lang, item)).join(" ").slice(0, 240))
        })
      }
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
      const mode = task.startMode ?? "builtin"
      if (mode === "monitor" || mode === "restock" || mode === "scheduled") continue
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
      if (!task.profileId) return "Monitor"
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
    const monitorTask = task.kind === "monitor" || task.monitorOnly === true
    if (!monitorTask) await this.warmIfDue(task, update)
    let proxy: ProxyEndpoint | undefined
    let proxies: ProxyEndpoint[] | undefined
    try {
      const profile = !monitorTask && task.profileId ? this.db.readProfile(task.profileId) : blankProfile()
      let account = blankAccount(task.store)
      if (!monitorTask && task.accountId) account = this.db.readAccount(task.accountId)
      let monitorProxy: ProxyEndpoint | undefined
      let monitorProxies: ProxyEndpoint[] | undefined
      if (account.id) {
        update({ log: line("info", `Using browser profile ${accountPartition(account.id)} for ${account.label}. Session cookies already saved for this account stay in that profile.`) })
        const preferredGroup = account.proxyGroupId || task.proxyGroupId
        if (task.proxyGroupId && account.proxyGroupId && task.proxyGroupId !== account.proxyGroupId) {
          update({ log: line("warn", "This task's proxy group does not override the account's sticky proxy.") })
        }
        if (task.monitorProxyGroupId && task.monitorProxyGroupId !== preferredGroup) {
          update({ log: line("warn", "Monitor checks use the account's sticky proxy. The monitor pool is not used.") })
        }
        if (preferredGroup) {
          const group = this.db.getProxyGroup(preferredGroup)
          const choice = this.db.assignProxy(account.id, group.id, group.proxies)
          if (choice.stickyOutside && choice.heldProxyId) {
            proxy = this.db.findProxy(choice.heldProxyId)
            proxies = proxy ? [proxy] : undefined
            update({ log: line("warn", "The selected proxy group does not include this account's sticky proxy. Keeping the sticky proxy.") })
          } else {
            proxy = choice.proxy
            proxies = proxy ? [proxy] : undefined
            const network = group.network === "residential" ? "residential" : "datacenter"
            const detail = !proxy
              ? `No free proxy is left in ${group.name}. Using a direct connection for this account.`
              : `Sticky ${network} proxy ${proxyLabel(proxy)} for ${account.label}. It stays on this proxy for the whole run.`
            update({ log: line(choice.allBenched ? "warn" : "info", detail) })
          }
        } else {
          update({ log: line("info", "Direct connection. This account has no proxy group.") })
        }
        monitorProxy = proxy
        monitorProxies = proxies
      } else {
        const separateMonitor = Boolean(task.monitorProxyGroupId && task.monitorProxyGroupId !== task.proxyGroupId)
        if (separateMonitor && task.monitorProxyGroupId) {
          const group = this.db.getProxyGroup(task.monitorProxyGroupId)
          monitorProxies = group.proxies
          const choice = this.db.assignProxy(task.id, group.id, group.proxies, Date.now(), false)
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
          const choice = this.db.assignProxy(`${task.id}:checkout`, group.id, group.proxies, Date.now(), false)
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
          update({ log: line("info", monitorTask ? "Monitoring anonymously. No proxy group selected." : "Direct connection. No proxy group selected.") })
        }
        if (monitorTask) update({ log: line("info", "Monitoring anonymously. Store accounts are used only when a checkout runs.") })
        if (!monitorProxy) {
          monitorProxy = proxy
          monitorProxies = proxies
        }
        if (monitorTask && monitorProxies?.length === 1) update({ log: line("warn", SINGLE_PROXY_WARNING) })
        if (monitorTask && monitorProxies?.length) {
          const loadedPace = this.db.getSettings()
          const fastest = Math.min(loadedPace.monitorDelayMs, loadedPace.monitorFastDelayMs || loadedPace.monitorDelayMs)
          const paceLine = perProxyPaceLine(task.store, monitorProxies.length, fastest)
          if (paceLine) update({ log: line("warn", paceLine) })
        }
      }
      const loaded = this.db.getSettings()
      const role = task.kind === "monitor" ? "monitor" : "checkout"
      const pace = resolvedValues(resolveModule(task.store, moduleScope(loaded), overridesWithStoreRole(task.store, role, loaded.storeRoles, task.overrides)))
      const settings = tuneSettings(loaded, task.store, pace)
      const jitterPct = typeof task.jitterPct === "number" ? task.jitterPct : loaded.monitorJitterPct
      const http = this.polite.wrap(task.store, monitorProxy?.id, this.http, (proxyId, status) => {
        this.db.noteTraffic(task.store, proxyId, status)
      }, controller.signal, {
        accountId: monitorTask ? undefined : account.id || undefined,
        proxyId: monitorProxy?.id,
        gapMs: pace.rateLimitMs,
        jitterPct
      })
      const checks: string[] = []
      if (testMode) update({ log: line("warn", "TEST MODE. The real flow runs through payment, then stops. The place-order request is not sent.") })
      let handoffs = 0
      let detectedAt = 0
      let announcedStock = false
      let openedStock = false
      const guarded = testMode ? guardTestMode(task.store, http) : http
      const ctx = {
        task: { id: task.id, sku: task.sku, quantity: task.quantity, store: task.store, maxPrice: task.maxPrice },
        healthCheck: () => {
          const report = this.db.assessTask(id)
          if (!report.blocked) return { ok: true as const }
          const lang = this.db.getSettings().language === "es" ? "es" : "en"
          return { ok: false as const, reason: report.issues.filter((item) => item.level === "block").map((item) => issueText(lang, item)).join(" ") }
        },
        spendCheck: (price: number | null) => {
          if (testMode) return { ok: true as const }
          const fresh = this.db.getTask(id)
          const cap = fresh.maxPrice
          if (cap && price !== null && price > cap) return { ok: false as const, reason: `The price is above this checkout's max of $${cap.toFixed(2)}.` }
          return allowCheckout(this.db.getSettings(), this.db.listCheckouts(), {
            store: task.store,
            sku: task.sku,
            accountId: account.id,
            quantity: task.quantity,
            price,
            now: Date.now(),
            dropStart: activeDropStart(this.db.listSchedules(), Date.now()),
            last4: profile.last4
          })
        },
        profile,
        account,
        settings,
        module: pace,
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
        monitorOnly: task.monitorOnly === true || task.kind === "monitor",
        checkoutDelayMs: task.checkoutDelayMs ?? 0,
        phase: (status: "monitoring" | "in_stock" | "adding_to_cart" | "checking_out" | "in_queue") => {
          if (status === "in_queue") {
            const queued = this.db.getTask(id).status === "in_queue"
            update({ status, detail: "In a store queue. Open the PC if the store asks a person to continue." })
            if (!queued) {
              void this.safeNotify(update, {
                kind: "paused",
                storeName: module.displayName,
                sku: task.sku,
                profileName: profileName(),
                detail: "In a store queue. Open the PC if the store asks a person to continue."
              })
            }
            return
          }
          if (status === "in_stock") detectedAt = Date.now()
          if (status === "adding_to_cart" && detectedAt) update({ detectToCartMs: Date.now() - detectedAt })
          update({ status })
          if (monitorTask && (status === "in_stock" || status === "monitoring")) {
            const change = this.stockAlerts.read(stockKey(task.store, task.sku), status === "in_stock")
            if (change) {
              update({ log: line(change === "instock" ? "success" : "warn", change === "instock" ? "In stock." : "Out of stock.") })
              const current = this.db.getTask(id)
              void this.safeNotify(update, {
                kind: change,
                store: task.store,
                storeName: module.displayName,
                sku: task.sku,
                profileName: "Monitor",
                detail: change === "instock" ? "The monitor saw this item in stock." : "This item went back out of stock.",
                imageUrl: current.imageUrl || undefined,
                url: /^https:\/\//.test(task.sku) ? task.sku : undefined,
                at: Date.now()
              })
            }
          }
          // A monitor never checks out, so it stays on the monitor proxies in every phase.
          // Moving to the checkout pool here sent an in-stock monitor out with no proxy at all.
          if (status === "monitoring" || monitorTask) {
            ctx.proxy = ctx.proxy && monitorProxies?.some((item) => item.id === ctx.proxy?.id) ? ctx.proxy : monitorProxy
            ctx.proxies = monitorProxies
            if (monitorTask && !openedStock) {
              openedStock = true
              update({
                log: line("info", monitorProxy
                  ? `Opening the stock check through proxy ${proxyLabel(monitorProxy)}.`
                  : "Opening the stock check with a direct connection.")
              })
            }
          } else {
            ctx.proxy = proxy
            ctx.proxies = proxies
          }
        },
        sleep: (ms: number) => {
          const fresh = this.refreshLive(id, settings, pace, ctx)
          const current = ctx.proxy
          const score = current ? this.db.proxyScores().find((item) => item.proxyId === current.id) : undefined
          const base = ms === settings.monitorDelayMs
            ? adaptiveDelay(fresh.store, Date.now(), settings, this.db.listSchedules(), Math.random())
            : jitterDelay(ms, settings.monitorJitterPct, Math.random())
          const floor = monitorTask ? perProxyFloorMs(task.store, ctx.proxies?.length || (ctx.proxy ? 1 : 0)) : 0
          return sleep(Math.max(base, floor) + backoffDelay(score?.streak ?? 0, pace.blockBackoffMs), controller.signal)
        },
        onSession: async (session: FullAccount["session"]) => {
          if (!session || !account.id) return
          this.db.updateSession(account.id, session)
          account = this.db.readAccount(account.id)
          ctx.account = account
          update({ log: line("info", `Saved the refreshed ${module.displayName} session locally.`) })
        },
        share: <T>(key: string, load: () => Promise<T>) => {
          if (monitorTask && this.hub.pending(key)) {
            update({ log: line("info", "This stock check is already running through the same proxy. Waiting for that result.") })
          }
          return this.hub.share(key, async () => {
          const started = Date.now()
          const value = await load()
          const status = readStatus(value)
          const timing = readTiming(value)
          const total = timing?.totalMs ?? Date.now() - started
          if (status !== null) {
            this.db.recordMonitor({
              store: task.store,
              ms: total,
              dnsMs: timing?.dnsMs,
              connectMs: timing?.connectMs,
              ttfbMs: timing?.ttfbMs,
              blocked: blockStatus(status),
              at: Date.now(),
              proxy: monitorProxy ? `${monitorProxy.host}:${monitorProxy.port}` : "direct"
            })
            update({ monitorMs: total })
            if (blockStatus(status) && Date.now() - (this.blockNotes.get(id) ?? 0) > 10 * 60_000) {
              this.blockNotes.set(id, Date.now())
              void this.safeNotify(update, {
                kind: "blocked",
                store: task.store,
                storeName: module.displayName,
                sku: task.sku,
                profileName: monitorProxy ? `${monitorProxy.host}:${monitorProxy.port}` : "direct",
                detail: `The store answered ${status}. The task backs off and keeps going.`,
                at: Date.now()
              })
            }
          }
          const image = readBody(value)
          if (image) {
            const url = productImage(image)
            if (url && !task.imageUrl) {
              try {
                update({ imageUrl: cleanImageUrl(url) })
              } catch {
                // A store image that is not https is ignored.
              }
            }
          }
          return value
          })
        },
        observe: (snapshot: WatchSnapshot) => {
          const fresh = this.refreshLive(id, settings, pace, ctx)
          const key = `${fresh.store}:${fresh.sku}`
          const prev = this.watches.get(key) ?? null
          this.watches.set(key, snapshot)
          if (prev && !prev.purchasable && snapshot.purchasable) {
            this.db.recordRestock({ store: fresh.store, sku: fresh.sku, at: Date.now(), price: snapshot.price, title: snapshot.title, kind: "restock", imageUrl: snapshot.imageUrl, url: snapshot.url })
          } else if (prev && prev.purchasable && !snapshot.purchasable) {
            this.db.recordRestock({ store: fresh.store, sku: fresh.sku, at: Date.now(), price: snapshot.price, title: snapshot.title, kind: "oos", imageUrl: snapshot.imageUrl, url: snapshot.url })
          } else if (prev && prev.price !== null && snapshot.price !== null && prev.price !== snapshot.price) {
            this.db.recordRestock({ store: fresh.store, sku: fresh.sku, at: Date.now(), price: snapshot.price, title: snapshot.title, kind: "price", imageUrl: snapshot.imageUrl, url: snapshot.url })
          }
          if (snapshot.imageUrl && !fresh.imageUrl) {
            try {
              update({ imageUrl: cleanImageUrl(snapshot.imageUrl) })
            } catch {
              // Ignore a non-https image.
            }
          }
          const edge = snapshot.purchasable && (!prev || !prev.purchasable)
          if (edge && (fresh.kind === "monitor" || fresh.monitorOnly)) {
            const decision = triggerDecision({
              keywords: fresh.keywords ?? "",
              priceCap: fresh.priceCap ?? null,
              activeHours: fresh.activeHours ?? "",
              soldBy: fresh.overrides?.soldBy,
              title: snapshot.title,
              price: snapshot.price,
              soldByRetailer: snapshot.soldByRetailer
            })
            if (decision.ok) this.startLinked(fresh)
            else update({ log: line("info", decision.reason) })
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
              sku: fresh.sku,
              profileName: profile.name,
              detail: message,
              price: snapshot.price,
              url: snapshot.url,
              imageUrl: snapshot.imageUrl,
              inStock: snapshot.purchasable
            })
          }
        },
        mailCode: this.readCode ? () => this.readCode!(task.store) : undefined,
        refreshSession: this.sessionRefresh && account.id
          ? (input: { homeUrl: string; proxy?: ProxyEndpoint; signal: AbortSignal }) => this.sessionRefresh!({
            accountId: account.id,
            store: task.store,
            homeUrl: input.homeUrl,
            proxy: input.proxy,
            existing: account.session,
            signal: input.signal,
            onChallenge: (message) => update({ log: line("warn", message) }),
            lookupCode: this.readCode ? () => this.readCode!(task.store) : undefined,
            onMailFilled: () => update({ log: line("info", "Filled the verification code from your mailbox.") })
          })
          : undefined
      }
      ctx.http = {
        request: async (input) => {
          if (monitorTask && !announcedStock) {
            announcedStock = true
            let host = "the store"
            try {
              host = new URL(input.url).hostname
            } catch {
              host = "the store"
            }
            update({ log: line("info", stockCheckLine(host, input.proxy ?? monitorProxy)) })
          }
          const stamped = account.id && !monitorTask ? { ...input, partition: accountPartition(account.id) } : input
          if (isFinalSubmit(task.store, stamped)) {
            if (!testMode) {
              const price = this.watches.get(`${task.store}:${task.sku}`)?.price ?? null
              const cap = this.db.getTask(id).maxPrice
              if (cap && price === null) throw new SpendLimitError(`The checkout price could not be verified against this checkout's $${cap.toFixed(2)} max, so the order was not sent.`)
              if (cap && price !== null && price > cap) throw new SpendLimitError(`The price is above this checkout's max of $${cap.toFixed(2)}.`)
              const decision = allowCheckout(this.db.getSettings(), this.db.listCheckouts(), {
                store: task.store,
                sku: task.sku,
                accountId: account.id,
                quantity: task.quantity,
                price,
                now: Date.now(),
                dropStart: activeDropStart(this.db.listSchedules(), Date.now()),
                last4: profile.last4
              })
              if (!decision.ok) throw new SpendLimitError(decision.reason)
            }
            return guarded.request(stamped)
          }
          const recovered = () => sendWithRecovery(ctx, stamped, {
            homeUrl: storeHome(task.store),
            inner: guarded,
            blocked: (response) => blockStatus(response.status, response)
          })
          const response = await recovered()
          if (module.handlesQueue) return response
          const queued = classifyTraffic(response) === "queue"
          const before = this.db.getTask(id).status
          const finished = await pollQueue(response, {
            method: stamped.method,
            fallbackMs: settings.monitorDelayMs,
            signal: controller.signal,
            sleep: (ms) => sleep(ms, controller.signal),
            again: recovered,
            onQueue: (detail) => update({ status: "in_queue", detail, log: line("info", detail) })
          })
          if (queued && classifyTraffic(finished) !== "queue") {
            const restore = before === "adding_to_cart" || before === "checking_out" || before === "in_stock" ? before : "monitoring"
            update({
              status: restore,
              detail: "The waiting room let this session through.",
              log: line("info", "The waiting room let this session through.")
            })
          }
          return finished
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
        await this.finishResult(update, result, { id, store: task.store, sku: task.sku, accountId: task.accountId, profileId: task.profileId, quantity: task.quantity, last4: profile.last4, clientId: task.clientId }, module.displayName, profileName())
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
      const message = plainNetworkError(err).message
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
    if (account.id && this.sessionRefresh) {
      return this.holdAccountBrowser(id, controller, update, account, proxy, storeNameText, profileNameText, reason, timeout)
    }
    const gate = this.challenges
    if (!gate) return null
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

  private async holdAccountBrowser(
    id: string,
    controller: AbortController,
    update: (patch: Parameters<Database["patchTask"]>[1]) => void,
    account: FullAccount,
    proxy: ProxyEndpoint | undefined,
    storeNameText: string,
    profileNameText: string,
    reason: string,
    timeout: number
  ): Promise<FullAccount | null> {
    const refresh = this.sessionRefresh
    if (!refresh) return null
    const task = this.db.getTask(id)
    try {
      const refreshed = await refresh({
        accountId: account.id,
        store: task.store,
        homeUrl: challengePageUrl(task.store, task.sku),
        proxy,
        existing: account.session,
        signal: controller.signal,
        holdMs: timeout * 1000,
        onChallenge: (message) => update({ log: line("warn", message) }),
        lookupCode: this.readCode ? () => this.readCode!(task.store) : undefined,
        onMailFilled: () => update({ log: line("info", "Filled the verification code from your mailbox.") })
      })
      if (controller.signal.aborted) {
        finish(update, "stopped", "Stopped", "info")
        return null
      }
      const header = cookieHeader(refreshed.cookies)
      if (!refreshed.challenged && header) {
        this.db.updateSession(account.id, applySolvedCookies(account.session, header))
        update({
          status: "monitoring",
          detail: "Challenge solved. Resuming.",
          finishedAt: undefined,
          log: line("success", "Saved the cookies from the account browser and resumed the task.")
        })
        return this.db.readAccount(account.id)
      }
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        finish(update, "stopped", "Stopped", "info")
        return null
      }
    }
    const detail = `The account browser is still showing a check. ${reason}`
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

  private async warmIfDue(task: PublicTask, update: (patch: Parameters<Database["patchTask"]>[1]) => void): Promise<void> {
    if (!this.warmAccount) return
    const settings = this.db.getSettings()
    if (!settings.warmOnStart) return
    const ids = accountsToWarm(task, this.db.listTasks(), this.db.listAccounts(), Date.now(), settings.sessionWarmupMin)
    for (const accountId of ids) {
      update({
        detail: "Warming the account session.",
        log: line("info", "Warming the account session. Nothing is added to cart.")
      })
      try {
        await this.warmAccount(accountId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        update({ log: line("warn", `Session warm-up did not finish (${message}). Continuing.`) })
      }
    }
  }

  private async finishResult(
    update: (patch: Parameters<Database["patchTask"]>[1]) => void,
    result: StoreRunResult,
    task: { id: string; store: StoreId; sku: string; accountId: string; profileId: string; quantity: number; last4?: string; clientId?: string },
    storeNameText: string,
    profileNameText: string
  ): Promise<void> {
    const sku = task.sku
    if (result.outcome === "success") {
      const watch = this.watches.get(`${task.store}:${sku}`)
      const product = watch?.title?.trim() || sku
      const price = typeof watch?.price === "number" ? watch.price : undefined
      finish(update, "success", result.detail, "success")
      this.remember(task, "success", profileNameText, result.detail, result.orderId, { product, price })
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
      try {
        const entry = this.db.recordLedger({
          clientId: clientIdOf(task.clientId),
          store: task.store,
          sku,
          product,
          quantity: task.quantity,
          price: price ?? null,
          orderId: result.orderId
        })
        const owner = this.db.clientById(entry.clientId)
        if (owner?.webhook) {
          try {
            await postDiscord(owner.webhook, clientSuccessNotice({
              clientName: owner.name,
              storeName: storeNameText,
              sku,
              product,
              quantity: task.quantity,
              price: price ?? null,
              orderId: result.orderId,
              fee: entry.fee
            }))
            update({ log: line("info", "Client notification sent.") })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            update({ log: line("warn", `Client notification failed: ${redact(message)}`) })
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        update({ log: line("warn", `Success ledger was not recorded: ${redact(message)}`) })
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
    const declined = Boolean(task.last4) && isCardDecline(result.reason)
    const detail = declined
      ? issueText(this.db.getSettings().language === "es" ? "es" : "en", { code: "decline-task", level: "block", vars: { last4: task.last4 ?? "" } })
      : result.reason
    if (declined && task.last4) {
      this.db.recordDecline({ taskId: task.id, last4: task.last4, store: task.store, sku: task.sku })
    }
    finish(update, "failed", detail, "error")
    this.remember(task, "failure", profileNameText, detail)
    await this.safeNotify(update, {
      kind: "failure",
      storeName: storeNameText,
      sku,
      profileName: profileNameText,
      detail
    })
  }

  private remember(task: { store: StoreId; sku: string; accountId: string; profileId: string; quantity: number; last4?: string; clientId?: string }, outcome: "success" | "failure" | "paused" | "tested", profileName: string, detail: string, orderId?: string, extra?: { product?: string; price?: number }): void {
    this.db.recordCheckout({
      store: task.store,
      sku: task.sku,
      product: extra?.product || task.sku,
      price: extra?.price,
      outcome,
      profileName,
      detail,
      orderId,
      accountId: task.accountId,
      profileId: task.profileId,
      quantity: task.quantity,
      last4: task.last4,
      clientId: task.clientId
    })
  }

  private startLinked(monitor: PublicTask): void {
    const active = (status: PublicTask["status"]) => isActiveStatus(status)
    for (const checkout of checkoutsToStart(monitor, this.db.listTasks(), active)) {
      try {
        this.start(checkout.id)
      } catch (err) {
        const message = err instanceof Error ? err.message : "The linked checkout did not start."
        this.db.patchTask(monitor.id, { log: line("warn", message) })
      }
    }
  }

  private refreshLive(id: string, settings: Settings, pace: ModulePace, ctx: { checkoutDelayMs?: number }): PublicTask {
    const fresh = this.db.getTask(id)
    const loaded = this.db.getSettings()
    const roleNow = fresh.kind === "monitor" ? "monitor" : "checkout"
    const paceNow = resolvedValues(resolveModule(fresh.store, moduleScope(loaded), overridesWithStoreRole(fresh.store, roleNow, loaded.storeRoles, fresh.overrides)))
    const tuned = tuneSettings(loaded, fresh.store, paceNow)
    if (typeof fresh.jitterPct === "number") tuned.monitorJitterPct = fresh.jitterPct
    Object.assign(settings, tuned)
    Object.assign(pace, paceNow)
    ctx.checkoutDelayMs = fresh.checkoutDelayMs ?? 0
    return fresh
  }

  private async safeNotify(update: (patch: Parameters<Database["patchTask"]>[1]) => void, notice: Notice): Promise<void> {
    try {
      if (!noticeAllowed(this.db.getSettings(), notice)) return
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

function readTiming(value: unknown): RequestTiming | undefined {
  if (!value || typeof value !== "object" || !("timing" in value)) return undefined
  const timing = value.timing
  if (!timing || typeof timing !== "object" || !("totalMs" in timing) || typeof timing.totalMs !== "number") return undefined
  return timing as RequestTiming
}

function readBody(value: unknown): string {
  if (!value || typeof value !== "object" || !("body" in value) || typeof value.body !== "string") return ""
  return value.body
}

function readStatus(value: unknown): number | null {
  if (!value || typeof value !== "object") return null
  if ("status" in value && typeof value.status === "number") return value.status
  if ("value" in value && value.value && typeof value.value === "object" && "status" in value.value && typeof value.value.status === "number") {
    return value.value.status
  }
  return null
}

function blankProfile(): FullProfile {
  const address = { firstName: "", lastName: "", line1: "", line2: "", city: "", state: "", zip: "", country: "US" as const }
  return {
    id: "",
    name: "Monitor",
    email: "",
    phone: "",
    shipping: address,
    billing: address,
    cardName: "",
    last4: "",
    expMonth: "",
    expYear: "",
    card: { number: "", cvv: "", expMonth: "", expYear: "", name: "" }
  }
}

function blankAccount(store: StoreId): FullAccount {
  return { id: "", store, label: "Monitor", username: "" }
}

function tuneSettings(settings: Settings, store: StoreId, pace: ModulePace): Settings {
  const next: Settings = {
    ...settings,
    monitorDelayMs: pace.monitorDelayMs,
    blockRetries: pace.maxRetries,
    sessionWarmupMin: Math.min(240, Math.max(10, pace.sessionRefreshMin))
  }
  const zip = pace.zips.split(",")[0]?.trim() ?? ""
  const storeId = pace.storeIds.split(",")[0]?.trim() ?? ""
  if (zip) next.monitorZips = pace.zips
  if (storeId) next.monitorStoreIds = pace.storeIds
  if (store === "target" && /^\d{5}/.test(zip)) next.targetZip = zip.slice(0, 5)
  if (store === "target" && /^\d{3,6}$/.test(storeId)) next.targetStoreId = storeId
  return next
}

function line(level: LogLevel, message: string) {
  return { ts: Date.now(), level, message: redact(message).slice(0, 500) }
}
