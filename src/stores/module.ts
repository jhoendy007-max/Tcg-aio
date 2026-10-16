import type { SessionRefreshResult } from "../engine/block-recovery"
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
  /** Every proxy in the task's group. A block rotates to the next healthy proxy for this account. */
  proxies?: ProxyEndpoint[]
  signal: AbortSignal
  /** Reloads the store in the account's real browser partition. Tests omit it. */
  refreshSession?: (input: { homeUrl: string; proxy?: ProxyEndpoint; signal: AbortSignal }) => Promise<SessionRefreshResult>
  http: HttpClient
  log: (level: LogLevel, message: string) => void
  detail: (message: string) => void
  phase: (status: TaskPhase) => void
  sleep: (ms: number) => Promise<void>
  onSession: (session: SessionCookies) => Promise<void>
}

export type StoreRunResult =
  | { outcome: "success"; orderId?: string; detail: string }
  | { outcome: "paused"; reason: string }
  | { outcome: "failed"; reason: string }
  | { outcome: "stopped"; reason: string }

export interface StoreModule {
  id: StoreId
  displayName: string
  skuHint: string
  implemented: boolean
  run(ctx: StoreRunContext): Promise<StoreRunResult>
}
