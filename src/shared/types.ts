export const STORE_IDS = [
  "target",
  "walmart",
  "bestbuy",
  "pokemon-center",
  "amazon",
  "crunchyroll"
] as const

export type StoreId = (typeof STORE_IDS)[number]

export interface StoreInfo {
  id: StoreId
  name: string
  skuHint: string
  implemented: boolean
}

export interface Address {
  firstName: string
  lastName: string
  line1: string
  line2: string
  city: string
  state: string
  zip: string
  country: "US"
}

export interface PublicProfile {
  id: string
  name: string
  email: string
  phone: string
  shipping: Address
  billing: Address
  cardName: string
  last4: string
  expMonth: string
  expYear: string
}

export interface ProfileInput {
  id?: string
  name: string
  email: string
  phone: string
  shipping: Address
  billing: Address
  cardName: string
  cardNumber: string
  expMonth: string
  expYear: string
  cvv: string
  cardAction: "keep" | "replace"
}

export interface CardSecret {
  number: string
  cvv: string
  expMonth: string
  expYear: string
  name: string
}

export interface FullProfile extends PublicProfile {
  card: CardSecret
}

export interface SessionCookies {
  accessToken: string
  visitorId?: string
  refreshToken?: string
  idToken?: string
  /** Original cookie header when the account pasted more than the named tokens. */
  cookie?: string
}

export interface PublicAccount {
  id: string
  store: StoreId
  label: string
  username: string
  hasPassword: boolean
  hasSession: boolean
}

export interface AccountInput {
  id?: string
  store: StoreId
  label: string
  username: string
  password: string
  passwordAction: "keep" | "replace" | "clear"
  session: string
  sessionAction: "keep" | "replace" | "clear"
}

export interface FullAccount {
  id: string
  store: StoreId
  label: string
  username: string
  password?: string
  session?: SessionCookies
}

export interface ProxyEndpoint {
  id: string
  host: string
  port: number
  username?: string
  password?: string
}

export interface ProxyGroup {
  id: string
  name: string
  proxies: ProxyEndpoint[]
}

export interface ProxyGroupInput {
  id?: string
  name: string
  text: string
}

export interface ProxyTestResult {
  id: string
  label: string
  ok: boolean
  ip?: string
  error?: string
}

export type LogLevel = "info" | "warn" | "error" | "success"

export interface LogLine {
  ts: number
  level: LogLevel
  message: string
}

export type TaskStatus =
  | "idle"
  | "monitoring"
  | "in_stock"
  | "adding_to_cart"
  | "checking_out"
  | "success"
  | "failed"
  | "paused"
  | "stopped"

export const ACTIVE_STATUSES: TaskStatus[] = [
  "monitoring",
  "in_stock",
  "adding_to_cart",
  "checking_out"
]

export function isActiveStatus(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

export interface PublicTask {
  id: string
  store: StoreId
  sku: string
  quantity: number
  profileId: string
  accountId: string
  proxyGroupId: string | null
  confirmPurchase: boolean
  status: TaskStatus
  detail: string
  logs: LogLine[]
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export interface TaskInput {
  id?: string
  store: StoreId
  sku: string
  quantity: number
  profileId: string
  accountId: string
  proxyGroupId: string | null
  confirmPurchase: boolean
}

export interface Settings {
  discordWebhook: string
  monitorDelayMs: number
  targetStoreId: string
  targetZip: string
  targetState: string
  targetApiKey: string
  /** Optional ws:// or wss:// relay so a paired phone can connect away from home. */
  phoneRelayUrl: string
}

export const DEFAULT_SETTINGS: Settings = {
  discordWebhook: "",
  monitorDelayMs: 3500,
  targetStoreId: "1881",
  targetZip: "10001",
  targetState: "NY",
  targetApiKey: "",
  phoneRelayUrl: ""
}

export interface SecurityInfo {
  method: "dpapi" | "aes"
  description: string
}

export interface SettingsPayload {
  settings: Settings
  security: SecurityInfo
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export type TaskEvent =
  | { type: "upsert"; task: PublicTask }
  | { type: "delete"; id: string }

export interface Notice {
  kind: "success" | "failure" | "paused"
  storeName: string
  sku: string
  profileName: string
  detail: string
  orderId?: string
}
