import { proxyLabel } from "../shared/proxy"
import { redact } from "../shared/redact"
import { storeName } from "../shared/stores"
import { isAbortError, sleep } from "./sleep"
import type { Database } from "./database"
import { defaultHttp, type HttpClient } from "./http"
import type { StoreModule } from "../stores/module"
import type { LogLevel, Notice, ProxyEndpoint, StoreId, TaskEvent, TaskStatus } from "../shared/types"

export class TaskService {
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly db: Database,
    private readonly modules: Map<StoreId, StoreModule>,
    private readonly emit: (event: TaskEvent) => void,
    private readonly notify: (notice: Notice) => Promise<boolean>,
    private readonly http: HttpClient = defaultHttp
  ) {}

  isRunning(id: string): boolean {
    return this.inflight.has(id)
  }

  start(id: string): void {
    if (this.inflight.has(id)) return
    const task = this.db.getTask(id)
    if (!task.confirmPurchase) {
      throw new Error("Confirm that this task may place a real shipping order before starting it.")
    }
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const promise = this.execute(id, controller).finally(() => {
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

  private async execute(id: string, controller: AbortController): Promise<void> {
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
    try {
      const profile = this.db.readProfile(task.profileId)
      const account = this.db.readAccount(task.accountId)
      if (task.proxyGroupId) {
        const group = this.db.getProxyGroup(task.proxyGroupId)
        proxy = pickProxy(group.proxies, task.id)
        update({
          log: line("info", proxy ? `Using proxy ${proxyLabel(proxy)} from ${group.name}.` : `Proxy group ${group.name} is empty. Using a direct connection.`)
        })
      } else {
        update({ log: line("info", "Direct connection. No proxy group selected.") })
      }
      const result = await module.run({
        task: { id: task.id, sku: task.sku, quantity: task.quantity, store: task.store },
        profile,
        account,
        settings: this.db.getSettings(),
        proxy,
        signal: controller.signal,
        http: this.http,
        log: (level, message) => update({ log: line(level, message) }),
        detail: (message) => update({ detail: redact(message).slice(0, 240) }),
        phase: (status) => update({ status }),
        sleep: (ms) => sleep(ms, controller.signal),
        onSession: async (session) => {
          this.db.updateSession(account.id, session)
          update({ log: line("info", "Saved the refreshed Target session locally.") })
        }
      })
      if (controller.signal.aborted || result.outcome === "stopped") {
        finish(update, "stopped", "Stopped", "info")
        return
      }
      if (result.outcome === "success") {
        finish(update, "success", result.detail, "success")
        await this.safeNotify(update, {
          kind: "success",
          storeName: module.displayName,
          sku: task.sku,
          profileName: profile.name,
          detail: result.detail,
          orderId: result.orderId
        })
        return
      }
      if (result.outcome === "paused") {
        finish(update, "paused", result.reason, "warn")
        await this.safeNotify(update, {
          kind: "paused",
          storeName: module.displayName,
          sku: task.sku,
          profileName: profile.name,
          detail: result.reason
        })
        return
      }
      finish(update, "failed", result.reason, "error")
      await this.safeNotify(update, {
        kind: "failure",
        storeName: storeName(task.store),
        sku: task.sku,
        profileName: profileName(),
        detail: result.reason
      })
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
