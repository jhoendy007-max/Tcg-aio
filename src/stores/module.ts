import { isAnonymousMonitor, monitorBlockWait, type SessionRefreshResult } from "../engine/block-recovery"
import type { WatchSnapshot } from "../engine/monitor"
import type { CheckResult, TestStage } from "../engine/test-mode"
import type { HttpClient } from "../engine/http"
import type { ModulePace } from "../shared/module-settings"
import type {
  FullAccount,
  FullProfile,
  LogLevel,
  ProxyEndpoint,
  SessionCookies,
  Settings,
  StoreId,
  TaskStatus
} from "../shared/types"

export type TaskPhase = Extract<TaskStatus, "monitoring" | "in_stock" | "adding_to_cart" | "checking_out" | "in_queue">

export interface StoreRunContext {
  task: { id: string; sku: string; quantity: number; store: StoreId; maxPrice?: number | null }
  /** Spend and quantity limits. The runner sets this. Test mode does not ask. */
  spendCheck?: (price: number | null) => { ok: true } | { ok: false; reason: string }
  /** Profile, address, session, and decline checks. The runner sets this from the same report used at start. */
  healthCheck?: () => { ok: true } | { ok: false; reason: string }
  profile: FullProfile
  account: FullAccount
  settings: Settings
  proxy?: ProxyEndpoint
  /** Proxies for the current phase. Monitoring and checkout can use different groups. */
  proxies?: ProxyEndpoint[]
  signal: AbortSignal
  /** Reloads the store in the account browser and returns cookies the site set. Tests omit it. */
  refreshSession?: (input: { homeUrl: string; proxy?: ProxyEndpoint; signal: AbortSignal }) => Promise<SessionRefreshResult>
  /** Join an in-flight stock read for this key instead of sending another request. */
  share?: <T>(key: string, load: () => Promise<T>) => Promise<T>
  /** Report a stock reading so price, offer, and availability changes can notify. */
  observe?: (snapshot: WatchSnapshot) => void
  http: HttpClient
  log: (level: LogLevel, message: string) => void
  detail: (message: string) => void
  phase: (status: TaskPhase) => void
  sleep: (ms: number) => Promise<void>
  onSession: (session: SessionCookies) => Promise<void>
  /** Read a one-time code from the user's own mailbox for this store. Tests omit it. */
  mailCode?: () => Promise<string | null>
  /** Watch stock only. The module must not add to cart. */
  monitorOnly?: boolean
  /** Extra wait before add-to-cart, in milliseconds. Zero uses the store pace only. */
  checkoutDelayMs?: number
  /** Resolved store settings. Task overrides already won. */
  module?: ModulePace
  /** Set for a test run. The HTTP client also refuses place-order requests. */
  testMode?: boolean
  clearCartAfterTest?: boolean
  mark?: (stage: TestStage, result: CheckResult, detail: string) => void
  checklistText?: () => string
}

/** A checkout delay waits first. Standard add-to-cart then waits one retry interval. Fast does not. */
export async function paceAddToCart(ctx: StoreRunContext): Promise<void> {
  const extra = Math.max(0, Math.round(ctx.checkoutDelayMs ?? 0))
  if (extra > 0) {
    ctx.log("info", `Waiting ${extra} ms before adding to cart.`)
    await ctx.sleep(extra)
  }
  if (ctx.module?.atcMode !== "standard") return
  ctx.log("info", "Standard add-to-cart is on for this store. Waiting one retry interval before adding.")
  await ctx.sleep(ctx.module.retryDelayMs)
}

export function checkoutPreflight(ctx: StoreRunContext, price?: number): { outcome: "paused"; reason: string } | null {
  const health = ctx.healthCheck?.()
  if (health && !health.ok) return { outcome: "paused", reason: health.reason }
  if (ctx.testMode) return null
  const verifiedPrice = typeof price === "number" && Number.isFinite(price) && price >= 0 ? price : undefined
  const cap = ctx.task.maxPrice
  if (typeof cap === "number" && cap > 0) {
    if (verifiedPrice === undefined) {
      return { outcome: "paused", reason: `A verified price is required to enforce this checkout's $${cap.toFixed(2)} max. No cart or payment request was sent.` }
    }
    if (verifiedPrice > cap) {
      return { outcome: "paused", reason: `The price $${verifiedPrice.toFixed(2)} is above this checkout's max of $${cap.toFixed(2)}.` }
    }
  }
  const decision = ctx.spendCheck?.(verifiedPrice ?? null)
  if (decision && !decision.ok) return { outcome: "paused", reason: decision.reason }
  return null
}

export function retryWait(ctx: StoreRunContext): number {
  const delay = ctx.module?.retryDelayMs ?? ctx.settings.monitorDelayMs
  if (isAnonymousMonitor(ctx)) return monitorBlockWait(ctx, Math.max(delay, ctx.settings.monitorDelayMs))
  return delay
}

export type StoreRunResult =
  | { outcome: "success"; orderId?: string; detail: string }
  | { outcome: "paused"; reason: string }
  | { outcome: "failed"; reason: string }
  | { outcome: "stopped"; reason: string }
  | { outcome: "tested"; detail: string }

export interface StoreModule {
  id: StoreId
  displayName: string
  skuHint: string
  implemented: boolean
  /** The module polls its own waiting room. The runner does not poll those GETs again. */
  handlesQueue?: boolean
  /** Orders allowed to one shipping address. Only a value under 3 is stricter than the default. */
  addressOrderCap?: number
  run(ctx: StoreRunContext): Promise<StoreRunResult>
}
