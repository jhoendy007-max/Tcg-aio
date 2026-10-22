import type { Client, ClientExport, ClientInput, ClientSummary, LedgerEntry } from "./clients"
import type { CheckoutSubject, HealthIssue, HealthReport } from "./checkout-health"
import { channels } from "./ipc"
import type {
  AccountInput,
  ProxyGroup,
  ProxyGroupInput,
  ProxyScore,
  ProxyTestResult,
  ProxyStoreTestResult,
  PublicAccount,
  PublicProfile,
  PublicTask,
  Result,
  Settings,
  SettingsPayload,
  StoreId,
  StoreInfo,
  TaskEvent,
  TaskInput,
  ProfileInput,
  AlertsView,
  DiscordWatchInput,
  KeywordWatch,
  KeywordWatchInput,
  RestockRule,
  RestockRuleInput,
  StoreHealth,
  PublicChallenge,
  AnalyticsReport,
  BulkEdit,
  BulkShared,
  DropSchedule,
  DropScheduleInput,
  CalendarEvent,
  CalendarEventInput,
  CalendarDropInput,
  UpdateStatus,
  TaskTemplate,
  TaskTemplateInput,
  OrderRecord,
  InventoryReport,
  ResaleQuery,
  ResaleQuote,
  ImapView,
  AccountView,
  ImapInput,
  MailboxInput,
  MailboxView,
  PublicVault
} from "./types"
import type { PhoneInvite, PhoneStatus } from "../phone/protocol"

export interface AioApi {
  tasks: {
    list: () => Promise<Result<PublicTask[]>>
    save: (input: TaskInput) => Promise<Result<PublicTask>>
    delete: (id: string) => Promise<Result<{ id: string }>>
    reorder: (ids: string[]) => Promise<Result<PublicTask[]>>
    start: (id: string) => Promise<Result<{ started: true }>>
    test: (id: string) => Promise<Result<{ started: true }>>
    stop: (id: string) => Promise<Result<{ stopped: true }>>
    onEvent: (cb: (event: TaskEvent) => void) => () => void
  }
  health: {
    check: (proxyGroupId: string | null) => Promise<Result<StoreHealth[]>>
  }
  profiles: {
    list: () => Promise<Result<PublicProfile[]>>
    save: (input: ProfileInput) => Promise<Result<PublicProfile>>
    delete: (id: string) => Promise<Result<{ id: string }>>
  }
  proxies: {
    list: () => Promise<Result<ProxyGroup[]>>
    save: (input: ProxyGroupInput) => Promise<Result<ProxyGroup>>
    delete: (id: string) => Promise<Result<{ id: string }>>
    test: (id: string) => Promise<Result<ProxyTestResult[]>>
    storeTest: (id: string) => Promise<Result<ProxyStoreTestResult[]>>
    health: () => Promise<Result<ProxyScore[]>>
  }
  accounts: {
    list: () => Promise<Result<PublicAccount[]>>
    save: (input: AccountInput) => Promise<Result<PublicAccount>>
    delete: (id: string) => Promise<Result<{ id: string }>>
    openBrowser: (id: string) => Promise<Result<{ opened: true }>>
    captureBrowser: (id: string) => Promise<Result<{ saved: true }>>
    warm: (id: string) => Promise<Result<{ expired: boolean; detail: string }>>
  }
  clients: {
    list: () => Promise<Result<Client[]>>
    summaries: () => Promise<Result<ClientSummary[]>>
    save: (input: ClientInput) => Promise<Result<Client>>
    delete: (id: string) => Promise<Result<{ accountIds: string[] }>>
    exportData: (id: string) => Promise<Result<ClientExport>>
    ledger: (clientId?: string) => Promise<Result<LedgerEntry[]>>
    markPaid: (clientId: string, ids: string[], paid: boolean) => Promise<Result<LedgerEntry[]>>
    csv: (clientId?: string) => Promise<Result<{ csv: string }>>
  }
  checkoutHealth: {
    preview: (input: CheckoutSubject) => Promise<Result<HealthReport>>
    client: (clientId: string) => Promise<Result<HealthReport>>
    tasks: () => Promise<Result<Array<{ taskId: string; issues: HealthIssue[] }>>>
  }
  settings: {
    get: () => Promise<Result<SettingsPayload>>
    save: (input: Settings) => Promise<Result<SettingsPayload>>
    testWebhook: () => Promise<Result<{ delivered: true }>>
    saveModule: (store: StoreId, record: unknown) => Promise<Result<SettingsPayload>>
    resetModule: (store: StoreId) => Promise<Result<SettingsPayload>>
    importModule: (text: string) => Promise<Result<SettingsPayload>>
  }
  stores: {
    list: () => Promise<Result<StoreInfo[]>>
  }
  phone: {
    status: () => Promise<Result<PhoneStatus>>
    invite: () => Promise<Result<PhoneInvite>>
    revoke: (id: string) => Promise<Result<PhoneStatus>>
    saveRelay: (url: string) => Promise<Result<PhoneStatus>>
    onEvent: (cb: (status: PhoneStatus) => void) => () => void
  }
  alerts: {
    get: () => Promise<Result<AlertsView>>
    rotateToken: () => Promise<Result<AlertsView>>
    saveDiscord: (input: DiscordWatchInput) => Promise<Result<AlertsView>>
    saveRule: (input: RestockRuleInput) => Promise<Result<RestockRule>>
    deleteRule: (id: string) => Promise<Result<{ id: string }>>
    saveWatch: (input: KeywordWatchInput) => Promise<Result<KeywordWatch>>
    deleteWatch: (id: string) => Promise<Result<{ id: string }>>
    resumeWatch: (id: string) => Promise<Result<KeywordWatch>>
    onEvent: (cb: (view: AlertsView) => void) => () => void
  }
  challenge: {
    get: () => Promise<Result<PublicChallenge | null>>
    open: () => Promise<Result<{ opened: true }>>
    done: () => Promise<Result<{ saved: true }>>
    submit: (cookie: string) => Promise<Result<{ saved: true }>>
    dismiss: () => Promise<Result<{ dismissed: true }>>
    onEvent: (cb: (challenge: PublicChallenge | null) => void) => () => void
  }
  schedules: {
    list: () => Promise<Result<DropSchedule[]>>
    save: (input: DropScheduleInput) => Promise<Result<DropSchedule>>
    delete: (id: string) => Promise<Result<{ id: string }>>
  }
  calendar: {
    list: () => Promise<Result<CalendarEvent[]>>
    save: (input: CalendarEventInput) => Promise<Result<CalendarEvent>>
    delete: (id: string) => Promise<Result<{ id: string }>>
    importFeed: (text: string) => Promise<Result<{ events: CalendarEvent[]; skipped: number }>>
    create: (input: CalendarDropInput) => Promise<Result<{ tasks: PublicTask[]; schedule: DropSchedule }>>
  }
  analytics: {
    get: () => Promise<Result<AnalyticsReport>>
    csv: () => Promise<Result<{ csv: string }>>
  }
  bulk: {
    create: (input: BulkShared) => Promise<Result<{ tasks: PublicTask[]; errors: string[] }>>
    edit: (input: BulkEdit) => Promise<Result<{ updated: string[]; errors: { id: string; error: string }[] }>>
    duplicate: (ids: string[]) => Promise<Result<PublicTask[]>>
    clone: (taskId: string, accountIds: string[]) => Promise<Result<PublicTask[]>>
    delete: (ids: string[]) => Promise<Result<{ deleted: string[]; errors: { id: string; error: string }[] }>>
  }
  updates: {
    get: () => Promise<Result<UpdateStatus>>
    check: () => Promise<Result<UpdateStatus>>
    download: () => Promise<Result<UpdateStatus>>
    install: () => Promise<Result<{ installing: true }>>
    saveToken: (input: { action: "keep" | "replace" | "clear"; token: string }) => Promise<Result<UpdateStatus>>
    onEvent: (cb: (status: UpdateStatus) => void) => () => void
  }
  autopilot: {
    list: () => Promise<Result<TaskTemplate[]>>
    save: (input: TaskTemplateInput) => Promise<Result<TaskTemplate>>
    delete: (id: string) => Promise<Result<{ id: string }>>
    orders: () => Promise<Result<OrderRecord[]>>
    imap: () => Promise<Result<ImapView>>
    saveImap: (input: ImapInput) => Promise<Result<ImapView>>
  }
  shipments: {
    list: () => Promise<Result<OrderRecord[]>>
    scan: () => Promise<Result<{ orders: OrderRecord[]; updated: number; note: string }>>
  }
  mail: {
    list: () => Promise<Result<MailboxView[]>>
    save: (input: MailboxInput) => Promise<Result<MailboxView>>
    delete: (id: string) => Promise<Result<{ id: string }>>
    test: (id: string) => Promise<Result<MailboxView>>
    signIn: (input: { provider: "gmail" | "outlook"; user: string }) => Promise<Result<MailboxView>>
    open: (url: string) => Promise<Result<{ opened: true }>>
  }
  resale: {
    quote: (input: ResaleQuery) => Promise<Result<ResaleQuote>>
  }
  inventory: {
    get: () => Promise<Result<InventoryReport>>
    setValue: (id: string, value: number | null) => Promise<Result<InventoryReport>>
    csv: () => Promise<Result<{ csv: string }>>
  }
  backup: {
    exportFile: (passphrase: string) => Promise<Result<{ file: string }>>
    restoreFile: (passphrase: string, file: string) => Promise<Result<{ restored: true }>>
    saveToken: (input: { action: "keep" | "replace" | "clear"; token: string }) => Promise<Result<{ hasToken: boolean }>>
    upload: (passphrase: string) => Promise<Result<{ uploaded: true }>>
    download: (passphrase: string) => Promise<Result<{ restored: true }>>
  }
  account: {
    status: () => Promise<Result<AccountView>>
    signIn: (input: { email: string; password: string }) => Promise<Result<AccountView>>
    signUp: (input: { email: string; password: string }) => Promise<Result<AccountView>>
    redeem: (input: { key: string }) => Promise<Result<AccountView>>
    signOut: () => Promise<Result<AccountView>>
    transfer: () => Promise<Result<AccountView>>
    openAdmin: () => Promise<Result<{ opened: true }>>
  }
  vault: {
    list: () => Promise<Result<PublicVault[]>>
    unlink: (deviceId: string, accountId: string) => Promise<Result<PublicVault[]>>
    setTwoWay: (deviceId: string, accountId: string, twoWay: boolean) => Promise<Result<PublicVault[]>>
  }
}

export const aioChannels = channels
