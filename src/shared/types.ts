export const STORE_IDS = [
  "target",
  "walmart",
  "bestbuy",
  "pokemon-center",
  "amazon",
  "crunchyroll",
  "bandai",
  "gamestop",
  "barnes-noble",
  "costco",
  "sams",
  "tcgplayer"
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

export type SessionState = "missing" | "saved" | "expired"

export interface PublicAccount {
  id: string
  store: StoreId
  label: string
  username: string
  hasPassword: boolean
  hasSession: boolean
  proxyGroupId: string | null
  sessionState: SessionState
  lastWarmAt: number | null
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
  proxyGroupId?: string | null
}

export interface FullAccount {
  id: string
  store: StoreId
  label: string
  username: string
  password?: string
  session?: SessionCookies
  proxyGroupId?: string | null
}

export type ProxyNetwork = "residential" | "datacenter"

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
  network: ProxyNetwork
  proxies: ProxyEndpoint[]
}

export interface ProxyGroupInput {
  id?: string
  name: string
  text: string
  network?: ProxyNetwork
}

export interface ProxyScore {
  proxyId: string
  streak: number
  ok: number
  blocks: number
  benchedUntil: number
  lastStatus: number | null
}

export interface StoreBlockRate {
  store: StoreId
  samples: number
  blocked: number
  rate: number
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
  | "tested"
  | "challenge"

export const ACTIVE_STATUSES: TaskStatus[] = [
  "monitoring",
  "in_stock",
  "adding_to_cart",
  "checking_out",
  "challenge"
]

export function isActiveStatus(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

export type TaskKind = "monitor" | "checkout"
export type StartMode = "manual" | "scheduled" | "monitor" | "restock" | "builtin"

export interface TaskRole {
  kind: TaskKind
  keywords: string
  priceCap: number | null
  webhook: string
  activeHours: string
  linkedCheckoutIds: string[]
  checkoutDelayMs: number | null
  maxPrice: number | null
  startMode: StartMode
  linkedMonitorId: string | null
  jitterPct: number | null
}

export interface PublicTask {
  id: string
  store: StoreId
  sku: string
  quantity: number
  profileId: string
  accountId: string
  proxyGroupId: string | null
  /** Stock checks use this pool. Checkout keeps proxyGroupId. Blank uses the checkout pool. */
  monitorProxyGroupId: string | null
  confirmPurchase: boolean
  testMode: boolean
  /** Optional label so a drop can start every task in the group. */
  group: string
  /** Lower numbers appear first. Missing values sort with the newest tasks. */
  rank?: number
  /** Optional https image. A monitor can fill this from the store's product payload. */
  imageUrl?: string
  /** Watch stock and notify. Never add to cart. True for monitor tasks. */
  monitorOnly?: boolean
  /** Fields this task sets itself. Blank fields use the store page. */
  overrides?: TaskOverrides
  kind?: TaskKind
  keywords?: string
  priceCap?: number | null
  webhook?: string
  activeHours?: string
  linkedCheckoutIds?: string[]
  checkoutDelayMs?: number | null
  maxPrice?: number | null
  startMode?: StartMode
  linkedMonitorId?: string | null
  jitterPct?: number | null
  /** Last shared stock-read time, in milliseconds. */
  monitorMs?: number
  /** Milliseconds from an in-stock reading to the add-to-cart call. */
  detectToCartMs?: number
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
  monitorProxyGroupId?: string | null
  confirmPurchase: boolean
  testMode?: boolean
  group?: string
  imageUrl?: string
  monitorOnly?: boolean
  overrides?: TaskOverrides
  kind?: TaskKind
  keywords?: string
  priceCap?: number | null
  webhook?: string
  activeHours?: string
  linkedCheckoutIds?: string[]
  checkoutDelayMs?: number | null
  maxPrice?: number | null
  startMode?: StartMode
  linkedMonitorId?: string | null
  jitterPct?: number | null
}

export type QueueMode = "wait" | "skip" | "pause"
export type AtcMode = "fast" | "standard"
export type SoldByMode = "retailer" | "any"

/** Saved values for one store. Absent keys use the recommended default. */
export interface ModuleRecord {
  monitorDelayMs?: number
  retryDelayMs?: number
  rateLimitMs?: number
  endpoint?: string
  zips?: string
  storeIds?: string
  queue?: QueueMode
  atcMode?: AtcMode
  soldBy?: SoldByMode
  sessionRefreshMin?: number
  maxRetries?: number
  testMode?: boolean
  blockBackoffMs?: number
  useGlobal?: Array<"monitorDelayMs" | "retryDelayMs" | "rateLimitMs" | "zips" | "storeIds" | "sessionRefreshMin" | "maxRetries" | "testMode" | "blockBackoffMs">
}

/** Set on a task. These beat the store page, which beats global Settings. */
export type TaskOverrides = Omit<ModuleRecord, "useGlobal">

export interface Settings {
  discordWebhook: string
  /** Opt-in feed for a shared server. Off until the user turns it on. */
  groupDiscord: boolean
  /** Separate from the personal webhook. Empty posts nowhere. */
  groupWebhook: string
  monitorDelayMs: number
  targetStoreId: string
  targetZip: string
  targetState: string
  targetApiKey: string
  /** Optional ws:// or wss:// relay so a paired phone can connect away from home. */
  phoneRelayUrl: string
  /** When on, every task runs as a test and cannot place an order. */
  testMode: boolean
  /** After a passed test, clear the cart on stores that support it. */
  clearCartAfterTest: boolean
  /** How long a person has to solve a store challenge before the task pauses. */
  challengeTimeoutSec: number
  /** Open the real browser session on a timer and save the cookies it already has. */
  sessionWarmup: boolean
  /** Minutes between session warm-ups. */
  sessionWarmupMin: number
  /** Percent of jitter added to monitor sleeps. */
  monitorJitterPct: number
  /** How many times to back off, rotate proxy, and reload the store session after a block. */
  blockRetries: number
  /** Poll interval inside a drop window. The per-store gap is still the floor. */
  monitorFastDelayMs: number
  /** Atlantic Time windows, one HH:MM-HH:MM per line. Scheduled drops count too. */
  dropWindows: string
  /** Extra ZIPs for stores whose ship-to-home stock changes by location. */
  monitorZips: string
  /** Extra store ids paired with those ZIPs. */
  monitorStoreIds: string
  alertPrice: boolean
  alertNewOffer: boolean
  alertAvailable: boolean
  alertRetailer: boolean
  /** When on, templates can create and start tasks from alerts, keywords, and learned restock hours. */
  autopilot: boolean
  /** Extra price cap for autopilot. 0 means the template cap is the only cap. */
  autopilotPriceCap: number
  /** Restart a task that has not logged anything for this many minutes. */
  stuckMinutes: number
  /** Windows login item. Off until the user turns it on. */
  launchOnBoot: boolean
  /** After a crash or an unclean exit, start tasks that were still running. */
  resumeOnLaunch: boolean
  /** Relaunch the app after an uncaught error, at most once a minute. */
  relaunchOnCrash: boolean
  /** 0 means no daily spend cap. */
  dailyBudget: number
  /** 0 means no cap for the active scheduled drop. */
  dropBudget: number
  /** 0 means no daily quantity cap for one SKU. */
  maxPerSku: number
  /** 0 means no daily order cap for one account. */
  maxPerAccount: number
  /** Lines like target:1. Max quantity of one SKU per account per day. */
  storePurchaseLimits: string
  /** Local time HH:MM. Blank turns the daily report off. */
  healthReportTime: string
  /** IANA timezone for budgets and the daily report. Blank uses UTC. */
  healthReportZone: string
  theme: "dark" | "light"
  accent: "gold" | "blue" | "green" | "rose"
  appName: string
  /** data:image URL, or empty. */
  logoDataUrl: string
  successSound: boolean
  taskView: "compact" | "detailed"
  wizardDone: boolean
  language: "en" | "es"
  /** Public OAuth client id for Sign in with Google. Not a secret. */
  googleMailClientId: string
  /** Public OAuth client id for Sign in with Microsoft. Not a secret. */
  microsoftMailClientId: string
  /** https URL the user owns. The upload token is not stored here. */
  backupUrl: string
  /** Optional https license server. Loopback http is allowed only for this PC. */
  licenseServerUrl: string
  /** When on, tasks do not start until this PC has an unexpired license. */
  licenseRequired: boolean
  /** Seller's public key. Not a secret. The private key is not stored here. */
  licensePublicKey: string
  /** Per-store defaults. Missing stores use the recommended values. */
  modules: Partial<Record<StoreId, ModuleRecord>>
}

export const DEFAULT_SETTINGS: Settings = {
  discordWebhook: "",
  groupDiscord: false,
  groupWebhook: "",
  monitorDelayMs: 3500,
  targetStoreId: "1881",
  targetZip: "10001",
  targetState: "NY",
  targetApiKey: "",
  phoneRelayUrl: "",
  testMode: false,
  clearCartAfterTest: false,
  challengeTimeoutSec: 180,
  sessionWarmup: false,
  sessionWarmupMin: 30,
  monitorJitterPct: 20,
  blockRetries: 3,
  monitorFastDelayMs: 1000,
  dropWindows: "",
  monitorZips: "",
  monitorStoreIds: "",
  alertPrice: true,
  alertNewOffer: true,
  alertAvailable: true,
  alertRetailer: true,
  autopilot: false,
  autopilotPriceCap: 0,
  stuckMinutes: 15,
  launchOnBoot: false,
  resumeOnLaunch: true,
  relaunchOnCrash: true,
  dailyBudget: 0,
  dropBudget: 0,
  maxPerSku: 0,
  maxPerAccount: 0,
  storePurchaseLimits: "",
  healthReportTime: "",
  healthReportZone: "",
  theme: "dark",
  accent: "gold",
  appName: "TCGAIO",
  logoDataUrl: "",
  successSound: false,
  taskView: "detailed",
  wizardDone: false,
  language: "en",
  googleMailClientId: "",
  microsoftMailClientId: "",
  backupUrl: "",
  licenseServerUrl: "",
  licenseRequired: false,
  licensePublicKey: "",
  modules: {}
}

export interface SecurityInfo {
  method: "dpapi" | "aes"
  description: string
}

export interface SettingsPayload {
  settings: Settings
  security: SecurityInfo
}

export interface LicenseView {
  machineId: string
  publicKey: string
  hasPrivateKey: boolean
  hasAdmin: boolean
  activated: boolean
  holder: string
  expiresAt: number | null
  seats: number
  issued: Array<{ id: string; holder: string; seats: number; expiresAt: number | null; revoked: boolean; machines: string[] }>
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export type TaskEvent =
  | { type: "upsert"; task: PublicTask }
  | { type: "delete"; id: string }

export interface StoreHealth {
  store: StoreId
  storeName: string
  proxy: string
  status: number | null
  verdict: "up" | "challenge" | "down"
  detail: string
  ms: number
  blockSamples: number
  blockCount: number
  blockRate: number
}

/** A store challenge waiting for a person. No proxy password and no cookie header. */
export interface PublicChallenge {
  id: string
  taskId: string
  store: StoreId
  storeName: string
  sku: string
  url: string
  reason: string
  expiresAt: number
  proxyLabel: string
}

export interface Notice {
  kind: "success" | "failure" | "paused" | "tested" | "alert" | "challenge" | "session" | "drop" | "health"
  storeName: string
  sku: string
  profileName: string
  detail: string
  orderId?: string
  price?: number | null
  url?: string
  imageUrl?: string
  inStock?: boolean
}

export interface TaskTemplate {
  id: string
  name: string
  enabled: boolean
  store: StoreId | ""
  sku: string
  keywords: string
  profileIds: string[]
  accountIds: string[]
  proxyGroupId: string | null
  monitorProxyGroupId: string | null
  quantity: number
  maxPrice: number | null
  testMode: boolean
  confirmPurchase: boolean
  group: string
  lastFiredAt: number
}

export interface TaskTemplateInput {
  id?: string
  name: string
  enabled: boolean
  store: StoreId | ""
  sku: string
  keywords: string
  profileIds: string[]
  accountIds: string[]
  proxyGroupId: string | null
  monitorProxyGroupId?: string | null
  quantity: number
  maxPrice: number | null
  testMode: boolean
  confirmPurchase: boolean
  group?: string
}

export type OrderStatus = "placed" | "confirmed" | "cancelled" | "shipped"

export interface OrderRecord {
  id: string
  at: number
  store: StoreId
  sku: string
  orderId: string
  accountId: string
  profileId: string
  status: OrderStatus
  tracking: string
  detail: string
  checkedAt: number
  quantity: number
}

export interface ImapView {
  enabled: boolean
  host: string
  port: number
  user: string
  mailbox: string
  hasPassword: boolean
}

export interface VaultLink {
  accountId: string
  deviceId: string
  twoWay: boolean
  linkedAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  loggedOut: boolean
  alertedDay: string
}

export interface PublicVault {
  accountId: string
  store: StoreId
  label: string
  sessionState: SessionState
  deviceId: string
  deviceName: string
  twoWay: boolean
  lastUsedAt: number | null
  expiresAt: number | null
  loggedOut: boolean
  flag: "ok" | "expiring" | "logged-out"
}

export interface ImapInput {
  enabled: boolean
  host: string
  port: number
  user: string
  mailbox: string
  password: string
  passwordAction: "keep" | "replace" | "clear"
}

export type MailProvider = "gmail" | "outlook" | "icloud" | "yahoo" | "custom"

export interface MailboxView {
  id: string
  name: string
  enabled: boolean
  provider: MailProvider
  host: string
  port: number
  secure: boolean
  user: string
  mailbox: string
  hasPassword: boolean
  orders: boolean
  alerts: boolean
  codes: boolean
  auth: "password" | "xoauth2"
  lastOkAt: number | null
  lastError: string
  folders: string[]
}

export interface MailboxInput {
  id?: string
  name: string
  enabled: boolean
  provider: MailProvider
  host: string
  port: number
  secure: boolean
  user: string
  mailbox: string
  password: string
  passwordAction: "keep" | "replace" | "clear"
  orders: boolean
  alerts: boolean
  codes: boolean
}

export interface MailboxStatus {
  accounts: number
  enabled: number
  ready: number
  lastError: string
}

export interface RestockRule {
  id: string
  name: string
  enabled: boolean
  /** Empty matches every store. */
  store: StoreId | ""
  /** Empty matches by keywords only. */
  sku: string
  keywords: string
  /** Existing task to start. Empty creates a task from the template below. */
  taskId: string | null
  profileId: string
  accountId: string
  proxyGroupId: string | null
  quantity: number
  maxQuantity: number
  maxPrice: number | null
  cooldownSec: number
  testMode: boolean
  confirmPurchase: boolean
  lastFiredAt: number
}

export interface RestockRuleInput {
  id?: string
  name: string
  enabled: boolean
  store: StoreId | ""
  sku: string
  keywords: string
  taskId: string | null
  profileId: string
  accountId: string
  proxyGroupId: string | null
  quantity: number
  maxQuantity: number
  maxPrice: number | null
  cooldownSec: number
  testMode: boolean
  confirmPurchase: boolean
}

export type WatchStatus = "idle" | "watching" | "paused" | "blocked"

export interface KeywordWatch {
  id: string
  name: string
  enabled: boolean
  store: StoreId
  keywords: string
  maxPrice: number | null
  soldByRetailer: boolean
  proxyGroupId: string | null
  profileId: string
  accountId: string
  quantity: number
  maxQuantity: number
  autoStart: boolean
  testMode: boolean
  confirmPurchase: boolean
  seenSkus: string[]
  status: WatchStatus
  detail: string
}

export interface KeywordWatchInput {
  id?: string
  name: string
  enabled: boolean
  store: StoreId
  keywords: string
  maxPrice: number | null
  soldByRetailer: boolean
  proxyGroupId: string | null
  profileId: string
  accountId: string
  quantity: number
  maxQuantity: number
  autoStart: boolean
  testMode: boolean
  confirmPurchase: boolean
  resetSeen?: boolean
}

export interface AlertLog {
  id: string
  ts: number
  source: "webhook" | "discord" | "keyword"
  store: string
  sku: string
  title: string
  result: string
}

export interface AlertsView {
  localUrl: string
  relayUrl: string
  token: string
  discordWatch: boolean
  hasBot: boolean
  channelId: string
  rules: RestockRule[]
  watches: KeywordWatch[]
  log: AlertLog[]
}

export interface DiscordWatchInput {
  channelId: string
  enabled: boolean
  token: string
  tokenAction: "keep" | "replace" | "clear"
}

export type SchedulePhase = "waiting" | "warming" | "started" | "stopped"

export interface DropSchedule {
  id: string
  name: string
  enabled: boolean
  startAt: number
  stopAt: number | null
  warmupMin: number
  taskIds: string[]
  group: string
  phase: SchedulePhase
}

export interface DropScheduleInput {
  id?: string
  name: string
  enabled: boolean
  /** Epoch milliseconds, or `YYYY-MM-DDTHH:mm` interpreted as Atlantic Time. */
  startAt: number | string
  stopAt?: number | string | null
  warmupMin: number
  taskIds: string[]
  group: string
}

export type CheckoutOutcome = "success" | "failure" | "paused" | "tested"

export interface CheckoutRecord {
  id: string
  at: number
  store: StoreId
  sku: string
  product: string
  price: number | null
  outcome: CheckoutOutcome
  profileName: string
  orderId?: string
  accountId?: string
  profileId?: string
  quantity?: number
  detail: string
  /** Current value of this purchase. Empty until the user enters one. */
  marketValue?: number | null
}

export interface StoreAnalytics {
  store: StoreId
  storeName: string
  success: number
  failure: number
  paused: number
  tested: number
  spend: number
}

export interface ProductAnalytics {
  store: StoreId
  sku: string
  product: string
  success: number
  failure: number
  paused: number
  spend: number
}

export interface TimelinePoint {
  day: string
  success: number
  failure: number
  paused: number
}

export interface AnalyticsReport {
  attempts: number
  success: number
  failure: number
  paused: number
  tested: number
  winRate: number
  spend: number
  byStore: StoreAnalytics[]
  byProduct: ProductAnalytics[]
  timeline: TimelinePoint[]
  recent: CheckoutRecord[]
  monitor: {
    samples: number
    blocked: number
    blockRate: number
    avgMs: number
    p50Ms: number
    p95Ms: number
    byStore: { store: StoreId; samples: number; blocked: number; blockRate: number; avgMs: number; p50Ms: number; p95Ms: number }[]
  }
  stockLog: { store: StoreId; sku: string; at: number; price: number | null; title: string; kind?: string; imageUrl?: string; url?: string }[]
  restockHints: { store: StoreId; sku: string; hourAst: number; samples: number; warmupMin: number; detail: string }[]
}

export interface InventoryRow {
  id: string
  at: number
  store: StoreId
  sku: string
  product: string
  quantity: number
  cost: number | null
  value: number | null
  profit: number | null
}

export interface InventoryReport {
  rows: InventoryRow[]
  purchases: number
  cost: number
  value: number
  profit: number
  unvalued: number
}

export interface ResaleQuery {
  title: string
  /** Total paid. Null when the user has not entered a cost. */
  cost: number | null
  quantity: number
  /** Percent of the sale price kept back for fees. Zero means fees are not subtracted. */
  feePct: number
  tcgProductId: string
}

export interface ResaleQuote {
  title: string
  cost: number | null
  quantity: number
  feePct: number
  tcgMarket: number | null
  tcgNote: string
  ebayMedian: number | null
  ebayCount: number
  ebayNote: string
  tcgProfit: number | null
  ebayProfit: number | null
  draft: string
  /** Always false. The quote is a draft and is not sent to a marketplace. */
  posted: false
}

export interface BulkShared {
  store: StoreId
  quantity: number
  profileId: string
  accountId: string
  proxyGroupId: string | null
  confirmPurchase: boolean
  testMode: boolean
  group: string
  text: string
}

export interface BulkEdit {
  ids: string[]
  quantity?: number
  profileId?: string
  accountId?: string
  proxyGroupId?: string | null
  confirmPurchase?: boolean
  testMode?: boolean
  group?: string
  keywords?: string
  priceCap?: number | null
  webhook?: string
  activeHours?: string
  checkoutDelayMs?: number | null
  maxPrice?: number | null
  jitterPct?: number | null
  monitorDelayMs?: number | null
  retryDelayMs?: number | null
}

export interface UpdateStatus {
  current: string
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "current" | "error"
  version: string | null
  notes: string
  phoneVersion: string | null
  error: string
  hasToken: boolean
}

export interface ReleaseAsset {
  version: string
  tag: string
  notes: string
  exe: string | null
  apk: string | null
}
