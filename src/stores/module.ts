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
  /** Every proxy in the task's group. Walmart rotates through these after an HTTP 412 block. */
  proxies?: ProxyEndpoint[]
  signal: AbortSignal
  http: HttpClient
  log: (level: LogLevel, message: string) => void
  detail: (message: string) => void
  phase: (status: TaskPhase) => void
  sleep: (ms: number) => Promise<void>
  onSession: (session: SessionCookies) => Promise<void>
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
