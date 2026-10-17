import type { SessionRefreshResult } from "../engine/block-recovery"
import type { WatchSnapshot } from "../engine/monitor"
import type { CheckResult, TestStage } from "../engine/test-mode"
import type { HttpClient } from "../engine/http"
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

export type TaskPhase = Extract<TaskStatus, "monitoring" | "in_stock" | "adding_to_cart" | "checking_out">

export interface StoreRunContext {
  task: { id: string; sku: string; quantity: number; store: StoreId }
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
  /** Watch stock only. The module must not add to cart. */
  monitorOnly?: boolean
  /** Set for a test run. The HTTP client also refuses place-order requests. */
  testMode?: boolean
  clearCartAfterTest?: boolean
  mark?: (stage: TestStage, result: CheckResult, detail: string) => void
  checklistText?: () => string
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
  run(ctx: StoreRunContext): Promise<StoreRunResult>
}
