import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Cipher } from "./cipher"
import { parseSession } from "./session"
import { cookieHeader } from "./challenge"
import { parseKeywordQuery } from "./keywords"
import { assertStore, cleanAddress, cleanCard, cleanEmail, cleanImageUrl, cleanPhone, cleanSettings } from "./validate"
import { AppError } from "../shared/errors"
import { parseProxyList } from "../shared/proxy"
import { applyBlockRates } from "./health"
import { isBlockStatus } from "./polite"
import { accountPartition, sessionFreshness } from "../shared/consistency"
import { clientIdOf, clientSummary, feeOwed, ledgerCsv as ledgerCsvText, ME_CLIENT_ID, meClient, proxyGroupTakenBy, roundMoney, type Client, type ClientExport, type ClientInput, type ClientSummary, type LedgerEntry } from "../shared/clients"
import { assessCheckout, assessClient, startOfLocalDay, type CardDecline, type CheckoutSubject, type HealthIssue, type HealthReport, type HealthWorld } from "../shared/checkout-health"
import { activeDropStart } from "./limits"
import { assertDiscordWebhook } from "./discord"
import { blockRate as tallyRate, chooseSticky, noteBlock, noteScore, type BlockTally, type StickyPin } from "./proxy-hygiene"
import { checkoutCsv, priceFromDetail, summarize } from "./analytics"
import { openBackup, sealBackup, type BackupAccount, type BackupDocument, type BackupProfile } from "./backup"
import { assertLicenseAllowed, bindMachine, createLicenseIdentity, readLicense, signLicense, type IssuedLicense, type LicenseStatus } from "./license"
import { suggestWarmups, summarizeMonitor, type MonitorSample, type RestockEvent } from "./monitor"
import { vaultFlag } from "./vault"
import { parseAstLocal } from "./time"
import { calendarTaskInputs, gameOf, parseCalendar } from "./calendar"
import { clonedTaskInputs } from "./clone-task"
import { channelIdsFrom } from "./discord-gate"
import { cleanModuleRecord, cleanTaskOverrides, parseModulePreset } from "../shared/module-settings"
import { cleanRole, normalizeRole, structuralChange } from "../shared/task-role"
import { DEFAULT_SETTINGS, STORE_IDS, isActiveStatus } from "../shared/types"
import { redact } from "../shared/redact"
import type {
  AccountInput,
  Address,
  AnalyticsReport,
  BulkEdit,
  CardSecret,
  CheckoutOutcome,
  CheckoutRecord,
  DropSchedule,
  DropScheduleInput,
  FullAccount,
  FullProfile,
  ProfileInput,
  ProxyGroup,
  ProxyGroupInput,
  ProxyNetwork,
  ProxyScore,
  StoreBlockRate,
  PublicAccount,
  PublicProfile,
  AlertLog,
  DiscordWatchInput,
  KeywordWatch,
  KeywordWatchInput,
  ProxyEndpoint,
  PublicTask,
  RestockRule,
  RestockRuleInput,
  SchedulePhase,
  SecurityInfo,
  SessionCookies,
  Settings,
  StoreHealth,
  StoreId,
  TaskInput,
  TaskTemplate,
  TaskTemplateInput,
  OrderRecord,
  OrderStatus,
  CalendarEvent,
  CalendarEventInput,
  CalendarDropInput,
  ImapView,
  ImapInput,
  MailboxInput,
  MailboxStatus,
  MailboxView,
  MailProvider,
  VaultLink,
  PublicVault
} from "../shared/types"
import { isMailProvider, providerForHost } from "../shared/mail"

interface ProfilePii {
  email: string
  phone: string
  shipping: Address
  billing: Address
}

interface ProfileRecord {
  id: string
  name: string
  cardName: string
  last4: string
  expMonth: string
  expYear: string
  cardSecret: string
  /** Encrypted email, phone, and addresses. The file does not store those in the clear. */
  piiSecret: string
  clientId: string
}

interface AccountRecord {
  id: string
  store: PublicAccount["store"]
  label: string
  username: string
  passwordSecret?: string
  sessionSecret?: string
  proxyGroupId?: string | null
  sessionState?: PublicAccount["sessionState"]
  lastWarmAt?: number | null
  clientId?: string
}

interface HygieneFile {
  pins: StickyPin[]
  scores: ProxyScore[]
  blocks: BlockTally[]
}

interface DeviceRecord {
  id: string
  name: string
  tokenSecret: string
  createdAt: number
  lastSeenAt: number
}

interface RestockFile {
  tokenSecret?: string
  discordBotSecret?: string
  discordChannelId: string
  discordChannelIds?: string[]
  discordCursors?: Record<string, string>
  discordWatch: boolean
  lastDiscordMessageId: string
  alertAllowlist?: string
  alertDedupeMin?: number
  alertSeen?: { key: string; at: number }[]
  rules: RestockRule[]
  watches: KeywordWatch[]
  log: AlertLog[]
}

interface UpdateFile {
  tokenSecret?: string
  desktopVersion: string | null
  phoneVersion: string | null
  notes: string
  checkedAt: number
}

interface LicenseRow extends IssuedLicense {
  tokenSecret: string
}

interface LicenseFile {
  publicKey: string
  privateSecret?: string
  adminSecret?: string
  issued: LicenseRow[]
  activation?: {
    tokenSecret: string
    licenseId: string
    holder: string
    expiresAt: number | null
    seats: number
    machineId: string
    activatedAt: number
  }
}

interface DbFile {
  version: 1
  pcId: string
  settings: Settings
  profiles: ProfileRecord[]
  accounts: AccountRecord[]
  proxyGroups: ProxyGroup[]
  tasks: PublicTask[]
  devices: DeviceRecord[]
  restock?: RestockFile
  hygiene?: HygieneFile
  schedules?: DropSchedule[]
  checkouts?: CheckoutRecord[]
  calendar?: CalendarEvent[]
  updates?: UpdateFile
  backup?: { tokenSecret?: string }
  license?: LicenseFile
  stockLog?: RestockEvent[]
  monitorSamples?: MonitorSample[]
  templates?: TaskTemplate[]
  orders?: OrderRecord[]
  heals?: Record<string, number>
  learnedKeys?: string[]
  reportDay?: string
  imap?: { enabled: boolean; host: string; port: number; user: string; mailbox: string; passwordSecret?: string }
  mailboxes?: MailboxFile[]
  vault?: VaultLink[]
  clients?: Client[]
  ledger?: LedgerEntry[]
  declines?: CardDecline[]
}

interface MailboxFile {
  id: string
  name: string
  enabled: boolean
  provider: MailProvider
  host: string
  port: number
  secure: boolean
  user: string
  mailbox: string
  passwordSecret?: string
  refreshSecret?: string
  auth: "password" | "xoauth2"
  orders: boolean
  alerts: boolean
  codes: boolean
  lastOkAt: number | null
  lastError: string
  folders: string[]
  seenAlertIds: string[]
}

export class Database {
  private data: DbFile = emptyDb()
  private interrupted: string[] = []
  private moduleAddressCaps: HealthWorld["moduleAddressCaps"] = {}

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher
  ) {}

  load(): void {
    if (!existsSync(this.file)) {
      this.data = emptyDb()
      this.flush()
      return
    }
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DbFile>
    if (parsed.version !== 1) throw new AppError("This data file was written by a newer TCGAIO version.")
    const pcId = typeof parsed.pcId === "string" && /^[0-9a-f-]{36}$/i.test(parsed.pcId) ? parsed.pcId : randomUUID()
    this.data = {
      version: 1,
      pcId,
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
      profiles: (parsed.profiles ?? []).map((profile) => sealProfile(profile, this.cipher)),
      accounts: (parsed.accounts ?? []).map((account) => ({ ...account, clientId: clientIdOf(account.clientId) })),
      proxyGroups: parsed.proxyGroups ?? [],
      tasks: (parsed.tasks ?? []).map((task) => ({ ...task, clientId: clientIdOf(task.clientId) })),
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      restock: normalizeRestock(parsed.restock),
      hygiene: normalizeHygiene(parsed.hygiene),
      schedules: normalizeSchedules(parsed.schedules),
      checkouts: normalizeCheckouts(parsed.checkouts),
      calendar: normalizeCalendar(parsed.calendar),
      updates: normalizeUpdates(parsed.updates),
      backup: normalizeBackup(parsed.backup),
      license: normalizeLicense(parsed.license),
      stockLog: Array.isArray(parsed.stockLog) ? parsed.stockLog.slice(0, 400) : [],
      monitorSamples: Array.isArray(parsed.monitorSamples) ? parsed.monitorSamples.slice(0, 500) : [],
      templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders.slice(0, 200) : [],
      heals: parsed.heals && typeof parsed.heals === "object" ? parsed.heals : {},
      learnedKeys: Array.isArray(parsed.learnedKeys) ? parsed.learnedKeys.slice(0, 200) : [],
      reportDay: typeof parsed.reportDay === "string" ? parsed.reportDay : "",
      imap: normalizeImap(parsed.imap),
      mailboxes: loadMailboxes(parsed.mailboxes, parsed.imap),
      vault: Array.isArray(parsed.vault) ? parsed.vault : [],
      clients: normalizeClients(parsed.clients),
      ledger: normalizeLedger(parsed.ledger),
      declines: normalizeDeclines(parsed.declines)
    }
    const migratedMail = !Array.isArray(parsed.mailboxes) && (this.data.mailboxes?.length ?? 0) > 0
    const migratedPii = (parsed.profiles ?? []).some((profile) => !profile.piiSecret || !profile.clientId)
    let changed = pcId !== parsed.pcId || !Array.isArray(parsed.devices) || migratedMail || migratedPii || !parsed.clients
    const interrupted: string[] = []
    for (const task of this.data.tasks) {
      task.group = typeof task.group === "string" ? task.group : ""
      if (isActiveStatus(task.status)) {
        interrupted.push(task.id)
        task.status = "paused"
        task.detail = "App closed while this task was running. Resume to continue."
        task.logs.push({ ts: Date.now(), level: "warn", message: task.detail })
        changed = true
      }
    }
    this.interrupted = interrupted
    if (changed) this.flush()
  }

  security(): SecurityInfo {
    return { method: this.cipher.method, description: this.cipher.description }
  }

  getSettings(): Settings {
    return { ...this.data.settings }
  }

  saveSettings(input: Settings): Settings {
    this.data.settings = cleanSettings(input)
    this.flush()
    return this.getSettings()
  }

  saveModule(store: StoreId, input: unknown): Settings {
    const settings = this.getSettings()
    const modules = { ...settings.modules, [store]: cleanModuleRecord(store, input) }
    return this.saveSettings({ ...settings, modules })
  }

  resetModule(store: StoreId): Settings {
    const settings = this.getSettings()
    const modules = { ...settings.modules }
    delete modules[store]
    return this.saveSettings({ ...settings, modules })
  }

  importModule(text: string): Settings {
    const preset = parseModulePreset(text)
    return this.saveModule(preset.store, preset.record)
  }

  listProfiles(): PublicProfile[] {
    return this.data.profiles.map((record) => this.openProfile(record))
  }

  saveProfile(input: ProfileInput): PublicProfile {
    const shipping = cleanAddress(input.shipping, "Shipping")
    const billing = cleanAddress(input.billing, "Billing")
    const name = input.name.trim()
    if (!name) throw new AppError("Profile name is required.")
    const email = cleanEmail(input.email)
    const phone = cleanPhone(input.phone)
    const existing = input.id ? this.requireProfile(input.id) : undefined
    let cardSecret = existing?.cardSecret
    let cardName = input.cardName.trim() || `${shipping.firstName} ${shipping.lastName}`
    let last4 = existing?.last4 ?? ""
    let expMonth = existing?.expMonth ?? ""
    let expYear = existing?.expYear ?? ""
    if (!existing && input.cardAction !== "replace") throw new AppError("Card number and CVV are required.")
    if (input.cardAction === "replace" && input.cardNumber.trim()) {
      const card = cleanCard(
        { cardName, cardNumber: input.cardNumber, expMonth: input.expMonth, expYear: input.expYear, cvv: input.cvv },
        cardName
      )
      cardSecret = this.cipher.encrypt(JSON.stringify(cardSecretFrom(card)))
      cardName = card.name
      last4 = card.last4
      expMonth = card.expMonth
      expYear = card.expYear
    } else if (input.cardAction === "replace" && input.cvv.trim()) {
      if (!existing) throw new AppError("Card number and CVV are required.")
      const current = this.decryptCard(existing)
      const card = cleanCard(
        {
          cardName,
          cardNumber: current.number,
          expMonth: input.expMonth,
          expYear: input.expYear,
          cvv: input.cvv
        },
        cardName
      )
      cardSecret = this.cipher.encrypt(JSON.stringify({ ...cardSecretFrom(card), number: current.number }))
      cardName = card.name
      last4 = card.last4
      expMonth = card.expMonth
      expYear = card.expYear
    } else if (existing) {
      const current = this.decryptCard(existing)
      const card = cleanCard(
        {
          cardName,
          cardNumber: current.number,
          expMonth: input.expMonth || current.expMonth,
          expYear: input.expYear || current.expYear,
          cvv: current.cvv
        },
        cardName
      )
      cardSecret = this.cipher.encrypt(JSON.stringify({ ...current, name: card.name, expMonth: card.expMonth, expYear: card.expYear }))
      cardName = card.name
      expMonth = card.expMonth
      expYear = card.expYear
      last4 = existing.last4
    }
    if (!cardSecret || !last4) throw new AppError("Card number and CVV are required.")
    const clientId = this.requireClient(clientIdOf(input.clientId || existing?.clientId)).id
    if (existing) this.assertProfileClient(existing.id, clientId)
    const record: ProfileRecord = {
      id: existing?.id ?? randomUUID(),
      name,
      cardName,
      last4,
      expMonth,
      expYear,
      cardSecret,
      piiSecret: this.cipher.encrypt(JSON.stringify({ email, phone, shipping, billing } satisfies ProfilePii)),
      clientId
    }
    if (existing) this.data.profiles = this.data.profiles.map((profile) => (profile.id === record.id ? record : profile))
    else this.data.profiles.push(record)
    this.flush()
    return this.openProfile(record)
  }

  deleteProfile(id: string): void {
    if (this.data.tasks.some((task) => task.profileId === id)) {
      throw new AppError("Delete or edit the tasks that use this profile first.")
    }
    this.data.profiles = this.data.profiles.filter((profile) => profile.id !== id)
    this.flush()
  }

  readProfile(id: string): FullProfile {
    const record = this.requireProfile(id)
    return { ...this.openProfile(record), card: this.decryptCard(record) }
  }

  private openProfile(record: ProfileRecord): PublicProfile {
    const pii = this.readPii(record)
    return {
      id: record.id,
      name: record.name,
      email: pii.email,
      phone: pii.phone,
      shipping: pii.shipping,
      billing: pii.billing,
      cardName: record.cardName,
      last4: record.last4,
      expMonth: record.expMonth,
      expYear: record.expYear,
      clientId: clientIdOf(record.clientId)
    }
  }

  private readPii(record: ProfileRecord): ProfilePii {
    try {
      const parsed = JSON.parse(this.cipher.decrypt(record.piiSecret)) as Partial<ProfilePii>
      return {
        email: typeof parsed.email === "string" ? parsed.email : "",
        phone: typeof parsed.phone === "string" ? parsed.phone : "",
        shipping: addressOrBlank(parsed.shipping),
        billing: addressOrBlank(parsed.billing)
      }
    } catch {
      throw new AppError("This profile could not be decrypted on this PC.")
    }
  }

  private assertProfileClient(profileId: string, clientId: string): void {
    for (const task of this.data.tasks) {
      if (task.profileId !== profileId || !task.accountId) continue
      const account = this.data.accounts.find((item) => item.id === task.accountId)
      if (account && clientIdOf(account.clientId) !== clientId) {
        throw new AppError("This profile is used with another client's account. Move the task first.")
      }
    }
  }

  private assertAccountClient(accountId: string, clientId: string): void {
    for (const task of this.data.tasks) {
      if (task.accountId !== accountId || !task.profileId) continue
      const profile = this.data.profiles.find((item) => item.id === task.profileId)
      if (profile && clientIdOf(profile.clientId) !== clientId) {
        throw new AppError("This account is used with another client's profile. Move the task first.")
      }
    }
  }

  listAccounts(): PublicAccount[] {
    const pins = this.hygiene().pins
    const proxies = this.data.proxyGroups.flatMap((group) => group.proxies)
    const freshMin = this.data.settings?.sessionWarmupMin ?? 30
    const now = Date.now()
    return this.data.accounts.map((record) => {
      const account = toPublicAccount(record)
      const pin = pins.find((item) => item.accountId === account.id && item.exclusive !== false)
      const proxy = pin ? proxies.find((item) => item.id === pin.proxyId) : undefined
      return {
        ...account,
        stickyProxyId: pin?.proxyId ?? null,
        stickyProxyLabel: proxy ? `${proxy.host}:${proxy.port}` : null,
        profilePartition: accountPartition(account.id),
        freshness: sessionFreshness(account, now, freshMin),
        clientId: clientIdOf(record.clientId)
      }
    })
  }

  saveAccount(input: AccountInput): PublicAccount {
    const store = assertStore(input.store)
    const label = input.label.trim()
    const username = cleanEmail(input.username)
    if (!label) throw new AppError("Account label is required.")
    const existing = input.id ? this.requireAccount(input.id) : undefined
    let passwordSecret = existing?.passwordSecret
    let sessionSecret = existing?.sessionSecret
    if (input.passwordAction === "clear") passwordSecret = undefined
    if (input.passwordAction === "replace") {
      if (!input.password) throw new AppError("Password is empty.")
      passwordSecret = this.cipher.encrypt(input.password)
    }
    if (input.sessionAction === "clear") sessionSecret = undefined
    if (input.sessionAction === "replace") {
      sessionSecret = this.cipher.encrypt(JSON.stringify(parseSession(input.session)))
    }
    const proxyGroupId = input.proxyGroupId ? this.getProxyGroup(input.proxyGroupId).id : input.proxyGroupId === null ? null : existing?.proxyGroupId ?? null
    const clientId = this.requireClient(clientIdOf(input.clientId || existing?.clientId)).id
    const taken = proxyGroupTakenBy(this.data.accounts.map((account) => ({ id: account.id, clientId: account.clientId, proxyGroupId: account.proxyGroupId ?? null })), existing?.id, clientId, proxyGroupId)
    if (taken) throw new AppError("That proxy group already belongs to another client. Each client needs their own proxy group.")
    if (existing) this.assertAccountClient(existing.id, clientId)
    const record: AccountRecord = {
      id: existing?.id ?? randomUUID(),
      store,
      label,
      username,
      passwordSecret,
      sessionSecret,
      proxyGroupId,
      sessionState: sessionSecret ? existing?.sessionState === "expired" && input.sessionAction !== "replace" ? "expired" : "saved" : "missing",
      lastWarmAt: sessionSecret ? existing?.lastWarmAt ?? null : null,
      clientId
    }
    if (existing) this.data.accounts = this.data.accounts.map((account) => (account.id === record.id ? record : account))
    else this.data.accounts.push(record)
    this.flush()
    return toPublicAccount(record)
  }

  deleteAccount(id: string): void {
    if (this.data.tasks.some((task) => task.accountId === id)) {
      throw new AppError("Delete or edit the tasks that use this account first.")
    }
    this.data.accounts = this.data.accounts.filter((account) => account.id !== id)
    this.data.vault = (this.data.vault ?? []).filter((link) => link.accountId !== id)
    this.flush()
  }

  readAccount(id: string): FullAccount {
    const record = this.requireAccount(id)
    return {
      id: record.id,
      store: record.store,
      label: record.label,
      username: record.username,
      password: record.passwordSecret ? this.cipher.decrypt(record.passwordSecret) : undefined,
      session: record.sessionSecret ? (JSON.parse(this.cipher.decrypt(record.sessionSecret)) as SessionCookies) : undefined,
      proxyGroupId: record.proxyGroupId ?? null
    }
  }

  private sessionListeners = new Set<(accountId: string) => void>()

  onSessionSaved(cb: (accountId: string) => void): () => void {
    this.sessionListeners.add(cb)
    return () => this.sessionListeners.delete(cb)
  }

  updateSession(id: string, session: SessionCookies, quiet = false): void {
    const record = this.requireAccount(id)
    record.sessionSecret = this.cipher.encrypt(JSON.stringify(session))
    record.sessionState = "saved"
    this.flush()
    if (!quiet) {
      for (const cb of this.sessionListeners) cb(id)
    }
  }

  markSession(id: string, state: PublicAccount["sessionState"], warmed: boolean): void {
    const record = this.requireAccount(id)
    record.sessionState = state
    if (warmed) record.lastWarmAt = Date.now()
    this.flush()
  }

  noteTraffic(store: StoreId, proxyId: string | undefined, status: number | null): void {
    const hygiene = this.hygiene()
    hygiene.scores = noteScore(hygiene.scores, proxyId, status, Date.now())
    hygiene.blocks = noteBlock(hygiene.blocks, store, isBlockStatus(status))
    this.flush()
  }

  recordHealth(rows: StoreHealth[], proxies: ProxyEndpoint[]): StoreHealth[] {
    const hygiene = this.hygiene()
    const now = Date.now()
    rows.forEach((row, index) => {
      const proxy = proxies.length ? proxies[index % proxies.length] : undefined
      hygiene.scores = noteScore(hygiene.scores, proxy?.id, row.status, now)
      hygiene.blocks = noteBlock(hygiene.blocks, row.store, isBlockStatus(row.status))
    })
    this.flush()
    return applyBlockRates(rows, STORE_IDS.map((store) => tallyRate(hygiene.blocks, store)))
  }

  blockRate(store: StoreId): StoreBlockRate {
    return tallyRate(this.hygiene().blocks, store)
  }

  proxyScores(): ProxyScore[] {
    const known = new Set(this.data.proxyGroups.flatMap((group) => group.proxies.map((proxy) => proxy.id)))
    return this.hygiene().scores.filter((score) => known.has(score.proxyId)).map((score) => ({ ...score }))
  }

  private hygiene(): HygieneFile {
    if (!this.data.hygiene) this.data.hygiene = emptyHygiene()
    return this.data.hygiene
  }

  assignProxy(accountId: string, groupId: string, proxies: ProxyEndpoint[], now = Date.now(), exclusive = true) {
    const hygiene = this.hygiene()
    const result = chooseSticky(proxies, hygiene.pins, hygiene.scores, accountId, groupId, now, exclusive)
    hygiene.pins = result.pins
    this.flush()
    return result.choice
  }

  findProxy(id: string): ProxyEndpoint | undefined {
    for (const group of this.data.proxyGroups) {
      const proxy = group.proxies.find((item) => item.id === id)
      if (proxy) return { ...proxy }
    }
    return undefined
  }

  listProxyGroups(): ProxyGroup[] {
    return this.data.proxyGroups.map((group) => ({
      ...group,
      network: group.network === "residential" ? "residential" : "datacenter",
      proxies: group.proxies.map((proxy) => ({ ...proxy }))
    }))
  }

  saveProxyGroup(input: ProxyGroupInput): ProxyGroup {
    const name = input.name.trim()
    if (!name) throw new AppError("Proxy group name is required.")
    const parsed = parseProxyList(input.text)
    if (!parsed.proxies.length) throw new AppError("Paste at least one proxy as host:port or host:port:user:pass.")
    if (parsed.skipped.length) {
      throw new AppError(`Could not parse: ${parsed.skipped.slice(0, 3).join(", ")}`)
    }
    const existing = input.id ? this.data.proxyGroups.find((group) => group.id === input.id) : undefined
    const network: ProxyNetwork = input.network === "residential" ? "residential" : "datacenter"
    const previous = new Map((existing?.proxies ?? []).map((proxy) => [`${proxy.host}:${proxy.port}:${proxy.username ?? ""}`, proxy.id]))
    const group: ProxyGroup = {
      id: existing?.id ?? randomUUID(),
      name,
      network,
      proxies: parsed.proxies.map((proxy) => ({
        ...proxy,
        id: previous.get(`${proxy.host}:${proxy.port}:${proxy.username ?? ""}`) ?? randomUUID()
      }))
    }
    if (existing) this.data.proxyGroups = this.data.proxyGroups.map((item) => (item.id === group.id ? group : item))
    else this.data.proxyGroups.push(group)
    this.flush()
    return group
  }

  deleteProxyGroup(id: string): void {
    if (this.data.tasks.some((task) => task.proxyGroupId === id)) {
      throw new AppError("Delete or edit the tasks that use this proxy group first.")
    }
    this.data.proxyGroups = this.data.proxyGroups.filter((group) => group.id !== id)
    this.flush()
  }

  getProxyGroup(id: string): ProxyGroup {
    const group = this.data.proxyGroups.find((item) => item.id === id)
    if (!group) throw new AppError("Proxy group not found.")
    if (group.network !== "residential" && group.network !== "datacenter") group.network = "datacenter"
    return group
  }

  listTasks(): PublicTask[] {
    return this.data.tasks.map(cloneTask).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.createdAt - a.createdAt)
  }

  reorderTasks(ids: string[]): PublicTask[] {
    const known = new Set(this.data.tasks.map((task) => task.id))
    let rank = 0
    for (const id of ids) {
      if (!known.has(id)) continue
      const task = this.data.tasks.find((item) => item.id === id)
      if (!task) continue
      task.rank = rank
      rank += 1
      known.delete(id)
    }
    for (const id of known) {
      const task = this.data.tasks.find((item) => item.id === id)
      if (task) task.rank = rank
      rank += 1
    }
    this.flush()
    return this.listTasks()
  }

  saveTask(input: TaskInput): PublicTask {
    const existing = input.id ? this.requireTask(input.id) : undefined
    if (existing && isActiveStatus(existing.status)) {
      const blocked = structuralChange(existing, input)
      if (blocked) throw new AppError(blocked)
      const role = cleanRole({ ...existing, ...input, store: existing.store, sku: existing.sku, quantity: existing.quantity, profileId: existing.profileId, accountId: existing.accountId }, existing)
      const next: PublicTask = {
        ...existing,
        ...role,
        monitorOnly: role.kind === "monitor",
        group: input.group === undefined ? existing.group : input.group.trim().slice(0, 40),
        overrides: cleanTaskOverrides(existing.store, input.overrides === undefined ? existing.overrides : input.overrides),
        testMode: input.testMode === undefined ? existing.testMode : input.testMode === true || existing.testMode
      }
      this.data.tasks = this.data.tasks.map((item) => (item.id === next.id ? next : item))
      this.syncLinks(next)
      this.flush()
      return cloneTask(next)
    }
    const task = this.taskFrom(input, existing)
    if (existing) this.data.tasks = this.data.tasks.map((item) => (item.id === task.id ? task : item))
    else this.data.tasks.unshift(task)
    this.syncLinks(task)
    this.flush()
    return cloneTask(task)
  }

  createTasks(inputs: TaskInput[]): PublicTask[] {
    if (!inputs.length) throw new AppError("Paste at least one SKU or URL.")
    if (inputs.length > 50) throw new AppError("Create at most 50 tasks at once.")
    const tasks = inputs.map((input) => this.taskFrom(input, undefined))
    this.data.tasks.unshift(...tasks)
    this.flush()
    return tasks.map(cloneTask)
  }

  cloneAcrossAccounts(taskId: string, accountIds: string[]): PublicTask[] {
    const task = this.requireTask(taskId)
    const accounts = [...new Set(accountIds)].map((id) => this.requireAccount(id))
    const planned = clonedTaskInputs(task, accounts)
    if (!planned.inputs.length) throw new AppError("Choose an account for this store.")
    if (planned.inputs.length > 50) throw new AppError("Clone at most 50 accounts at once.")
    return planned.inputs.map((input) => this.saveTask(input))
  }

  duplicateTasks(ids: string[]): PublicTask[] {
    const copies = ids.map((id) => {
      const task = this.requireTask(id)
      return {
        ...cloneTask(task),
        id: randomUUID(),
        status: "idle" as const,
        detail: "",
        logs: [],
        createdAt: Date.now(),
        startedAt: undefined,
        finishedAt: undefined
      }
    })
    if (!copies.length) throw new AppError("Choose at least one task.")
    this.data.tasks.unshift(...copies)
    this.flush()
    return copies.map(cloneTask)
  }

  deleteTasks(ids: string[]): { deleted: string[]; errors: { id: string; error: string }[] } {
    const deleted: string[] = []
    const errors: { id: string; error: string }[] = []
    for (const id of ids) {
      const task = this.data.tasks.find((item) => item.id === id)
      if (!task) errors.push({ id, error: "Task not found." })
      else if (isActiveStatus(task.status)) errors.push({ id, error: "Stop the task before deleting it." })
      else deleted.push(id)
    }
    if (deleted.length) {
      const gone = new Set(deleted)
      this.data.tasks = this.data.tasks.filter((task) => !gone.has(task.id))
      this.flush()
    }
    return { deleted, errors }
  }

  bulkEdit(input: BulkEdit): { updated: string[]; errors: { id: string; error: string }[] } {
    const updated: string[] = []
    const errors: { id: string; error: string }[] = []
    const account = input.accountId ? this.requireAccount(input.accountId) : undefined
    if (input.profileId) this.requireProfile(input.profileId)
    if (input.proxyGroupId) this.getProxyGroup(input.proxyGroupId)
    const quantity = input.quantity === undefined ? undefined : Math.round(Number(input.quantity))
    if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1 || quantity > 12)) {
      throw new AppError("Quantity must be from 1 to 12.")
    }
    for (const id of input.ids) {
      const task = this.data.tasks.find((item) => item.id === id)
      if (!task) {
        errors.push({ id, error: "Task not found." })
        continue
      }
      try {
        const roleNow = normalizeRole(task)
        const active = isActiveStatus(task.status)
        let nextQuantity = task.quantity
        let profileId = task.profileId
        let accountId = task.accountId
        let proxyGroupId = task.proxyGroupId
        let confirmPurchase = task.confirmPurchase
        let testMode = task.testMode
        let structuralError = ""
        const monitorFields = Boolean(input.profileId) || Boolean(input.accountId) || input.confirmPurchase !== undefined || input.proxyGroupId !== undefined
        if (roleNow.kind === "monitor" && monitorFields) structuralError = "A monitor task does not use a profile, account, or checkout proxy."
        const wantsStructure = input.quantity !== undefined || monitorFields || input.testMode === false
        if (!structuralError && active && wantsStructure) structuralError = "Stop the task before changing the quantity, profile, account, or proxy."
        if (!structuralError && roleNow.kind === "checkout") {
          if (account && account.store !== task.store) throw new AppError("Choose an account for the same store as the task.")
          if (quantity !== undefined) nextQuantity = quantity
          if (input.profileId) profileId = input.profileId
          if (account) accountId = account.id
          if (input.proxyGroupId !== undefined) proxyGroupId = input.proxyGroupId || null
          if (input.confirmPurchase !== undefined) confirmPurchase = input.confirmPurchase
          if (input.testMode === false) testMode = false
        } else if (!structuralError && quantity !== undefined) {
          nextQuantity = quantity
        }
        if (input.testMode === true) testMode = true
        if (!structuralError && roleNow.kind === "checkout" && profileId && accountId) {
          const boundProfile = this.data.profiles.find((item) => item.id === profileId)
          const boundAccount = this.data.accounts.find((item) => item.id === accountId)
          if (boundProfile && boundAccount && clientIdOf(boundProfile.clientId) !== clientIdOf(boundAccount.clientId)) {
            throw new AppError("The profile and the account have to belong to the same client.")
          }
          if (boundAccount) task.clientId = clientIdOf(boundAccount.clientId)
        }
        const role = cleanRole({
          ...task,
          quantity: nextQuantity,
          profileId,
          accountId,
          proxyGroupId,
          confirmPurchase,
          testMode,
          keywords: input.keywords === undefined ? task.keywords : input.keywords,
          priceCap: input.priceCap === undefined ? task.priceCap : input.priceCap,
          webhook: input.webhook === undefined ? task.webhook : input.webhook,
          activeHours: input.activeHours === undefined ? task.activeHours : input.activeHours,
          checkoutDelayMs: input.checkoutDelayMs === undefined ? task.checkoutDelayMs : input.checkoutDelayMs,
          maxPrice: input.maxPrice === undefined ? task.maxPrice : input.maxPrice,
          jitterPct: input.jitterPct === undefined ? task.jitterPct : input.jitterPct
        }, task)
        let overrides = task.overrides
        if (input.monitorDelayMs !== undefined || input.retryDelayMs !== undefined) {
          const next = { ...task.overrides }
          if (input.monitorDelayMs !== undefined) {
            if (!input.monitorDelayMs) delete next.monitorDelayMs
            else next.monitorDelayMs = Math.round(input.monitorDelayMs)
          }
          if (input.retryDelayMs !== undefined) {
            if (!input.retryDelayMs) delete next.retryDelayMs
            else next.retryDelayMs = Math.round(input.retryDelayMs)
          }
          overrides = cleanTaskOverrides(task.store, next)
        }
        task.quantity = nextQuantity
        task.profileId = profileId
        task.accountId = accountId
        task.proxyGroupId = proxyGroupId
        task.confirmPurchase = confirmPurchase
        task.testMode = testMode
        task.group = input.group === undefined ? task.group : input.group.trim().slice(0, 40)
        task.monitorOnly = role.kind === "monitor"
        task.overrides = overrides
        Object.assign(task, role)
        if (structuralError) errors.push({ id, error: structuralError })
        updated.push(id)
      } catch (err) {
        errors.push({ id, error: err instanceof Error ? err.message : "Could not edit the task." })
      }
    }
    if (updated.length) this.flush()
    return { updated, errors }
  }

  private taskFrom(input: TaskInput, existing: PublicTask | undefined): PublicTask {
    const role = cleanRole(input, existing)
    const store = assertStore(input.store)
    const sku = input.sku.trim()
    if (!sku && !role.keywords) throw new AppError("Product SKU, URL, or keywords are required.")
    const quantity = role.kind === "monitor" ? Math.max(1, Math.min(12, Math.round(Number(input.quantity) || 1))) : Math.round(Number(input.quantity))
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) throw new AppError("Quantity must be from 1 to 12.")
    let profileId = input.profileId || ""
    let accountId = input.accountId || ""
    let clientId = ME_CLIENT_ID
    if (role.kind === "checkout") {
      const profile = this.requireProfile(profileId)
      const account = this.requireAccount(accountId)
      if (account.store !== store) throw new AppError("Choose an account for the same store as the task.")
      const profileClient = clientIdOf(profile.clientId)
      const accountClient = clientIdOf(account.clientId)
      if (profileClient !== accountClient) throw new AppError("The profile and the account have to belong to the same client.")
      clientId = accountClient
    } else {
      profileId = ""
      accountId = ""
      clientId = this.requireClient(clientIdOf(input.clientId || existing?.clientId)).id
    }
    if (input.proxyGroupId) this.getProxyGroup(input.proxyGroupId)
    if (input.monitorProxyGroupId) this.getProxyGroup(input.monitorProxyGroupId)
    const ranks = this.data.tasks.map((task) => task.rank ?? 0)
    return {
      id: existing?.id ?? randomUUID(),
      store,
      sku,
      quantity,
      profileId,
      accountId,
      proxyGroupId: role.kind === "monitor" ? null : input.proxyGroupId || null,
      monitorProxyGroupId: role.kind === "monitor"
        ? input.monitorProxyGroupId || input.proxyGroupId || null
        : input.monitorProxyGroupId === undefined ? existing?.monitorProxyGroupId ?? null : input.monitorProxyGroupId || null,
      confirmPurchase: role.kind === "monitor" ? false : Boolean(input.confirmPurchase),
      testMode: input.testMode === true,
      group: (input.group ?? existing?.group ?? "").trim().slice(0, 40),
      rank: existing?.rank ?? (ranks.length ? Math.min(...ranks) - 1 : 0),
      imageUrl: input.imageUrl === undefined ? existing?.imageUrl ?? "" : cleanImageUrl(input.imageUrl),
      monitorOnly: role.kind === "monitor",
      clientId,
      overrides: cleanTaskOverrides(store, input.overrides === undefined ? existing?.overrides : input.overrides),
      ...role,
      status: existing?.status === "paused" ? "paused" : "idle",
      detail: existing?.detail ?? "",
      logs: existing?.logs ?? [],
      createdAt: existing?.createdAt ?? Date.now(),
      startedAt: existing?.startedAt,
      finishedAt: existing?.finishedAt
    }
  }

  private syncLinks(task: PublicTask): void {
    if (task.kind !== "monitor") return
    const linked = new Set(task.linkedCheckoutIds ?? [])
    for (const other of this.data.tasks) {
      if (other.id === task.id || other.kind === "monitor") continue
      if (linked.has(other.id)) {
        other.linkedMonitorId = task.id
        if (!other.startMode || other.startMode === "builtin" || other.startMode === "manual") other.startMode = "monitor"
      } else if (other.linkedMonitorId === task.id) {
        other.linkedMonitorId = null
      }
    }
  }

  listSchedules(): DropSchedule[] {
    return (this.data.schedules ?? []).map((schedule) => ({ ...schedule, taskIds: [...schedule.taskIds] }))
  }

  saveSchedule(input: DropScheduleInput): DropSchedule {
    const name = input.name.trim()
    if (!name) throw new AppError("Schedule name is required.")
    const startAt = typeof input.startAt === "number" ? input.startAt : parseAstLocal(String(input.startAt))
    if (!Number.isFinite(startAt)) throw new AppError("Start time is required.")
    const stopRaw = input.stopAt
    const stopAt = stopRaw === null || stopRaw === undefined || stopRaw === "" ? null : typeof stopRaw === "number" ? stopRaw : parseAstLocal(String(stopRaw))
    if (stopAt !== null && (!Number.isFinite(stopAt) || stopAt <= startAt)) throw new AppError("Stop time has to be after the start time.")
    const warmupMin = Math.round(Number(input.warmupMin))
    if (!Number.isInteger(warmupMin) || warmupMin < 0 || warmupMin > 180) throw new AppError("Warm-up has to be from 0 to 180 minutes.")
    const rehearsalMin = Math.round(Number(input.rehearsalMin ?? 0))
    if (!Number.isInteger(rehearsalMin) || rehearsalMin < 0 || rehearsalMin > 180) throw new AppError("Rehearsal has to be from 0 to 180 minutes.")
    const taskIds = [...new Set((input.taskIds ?? []).filter((id) => typeof id === "string" && id))]
    const group = (input.group ?? "").trim().slice(0, 40)
    if (!taskIds.length && !group) throw new AppError("Choose tasks or a task group.")
    for (const id of taskIds) this.requireTask(id)
    if (taskIds.length > 100) throw new AppError("A drop can include at most 100 tasks.")
    const existing = input.id ? this.data.schedules?.find((schedule) => schedule.id === input.id) : undefined
    const schedule: DropSchedule = {
      id: existing?.id ?? randomUUID(),
      name: name.slice(0, 80),
      enabled: input.enabled !== false,
      startAt,
      stopAt,
      warmupMin,
      rehearsalMin,
      rehearsalAt: existing && existing.startAt === startAt ? existing.rehearsalAt ?? null : null,
      taskIds,
      group,
      phase: existing && existing.startAt === startAt ? existing.phase : "waiting"
    }
    if (!this.data.schedules) this.data.schedules = []
    if (existing) this.data.schedules = this.data.schedules.map((item) => (item.id === schedule.id ? schedule : item))
    else this.data.schedules.push(schedule)
    this.flush()
    return { ...schedule, taskIds: [...schedule.taskIds] }
  }

  deleteSchedule(id: string): void {
    const next = (this.data.schedules ?? []).filter((schedule) => schedule.id !== id)
    if (next.length === (this.data.schedules ?? []).length) throw new AppError("That drop was not found.")
    this.data.schedules = next
    this.flush()
  }

  setSchedulePhase(id: string, phase: SchedulePhase): void {
    const schedule = this.data.schedules?.find((item) => item.id === id)
    if (!schedule || schedule.phase === phase) return
    schedule.phase = phase
    this.flush()
  }

  markRehearsal(id: string, at: number): void {
    const schedule = this.data.schedules?.find((item) => item.id === id)
    if (!schedule) return
    schedule.rehearsalAt = at
    this.flush()
  }

  listCalendar(): CalendarEvent[] {
    return (this.data.calendar ?? []).map((event) => ({ ...event }))
  }

  saveCalendarEvent(input: CalendarEventInput): CalendarEvent {
    const game = gameOf(input.game)
    if (!game) throw new AppError("The calendar only accepts Pokémon and One Piece.")
    const name = input.name.trim()
    if (!name) throw new AppError("Release name is required.")
    const startAt = typeof input.startAt === "number" ? input.startAt : parseAstLocal(String(input.startAt))
    if (!Number.isFinite(startAt)) throw new AppError("Start time is required.")
    const store = assertStore(input.store)
    const sku = input.sku.trim()
    if (!sku) throw new AppError("SKU is required.")
    const existing = input.id ? this.data.calendar?.find((event) => event.id === input.id) : undefined
    const event: CalendarEvent = {
      id: existing?.id ?? randomUUID(),
      game,
      name: name.slice(0, 80),
      startAt,
      store,
      sku: sku.slice(0, 180),
      note: (input.note ?? "").trim().slice(0, 180)
    }
    if (!this.data.calendar) this.data.calendar = []
    if (existing) this.data.calendar = this.data.calendar.map((item) => (item.id === event.id ? event : item))
    else this.data.calendar.unshift(event)
    this.flush()
    return { ...event }
  }

  importCalendar(text: string): { events: CalendarEvent[]; skipped: number } {
    const parsed = parseCalendar(text)
    if ("error" in parsed) throw new AppError(parsed.error)
    const saved: CalendarEvent[] = []
    for (const draft of parsed.events) {
      const existing = (this.data.calendar ?? []).find((event) => event.game === draft.game && event.store === draft.store && event.sku === draft.sku && event.startAt === draft.startAt)
      saved.push(this.saveCalendarEvent({ ...draft, id: existing?.id }))
    }
    return { events: saved, skipped: parsed.skipped }
  }

  deleteCalendarEvent(id: string): void {
    const next = (this.data.calendar ?? []).filter((event) => event.id !== id)
    if (next.length === (this.data.calendar ?? []).length) throw new AppError("That release was not found.")
    this.data.calendar = next
    this.flush()
  }

  createCalendarDrop(input: CalendarDropInput): { tasks: PublicTask[]; schedule: DropSchedule } {
    const event = this.data.calendar?.find((item) => item.id === input.eventId)
    if (!event) throw new AppError("That release was not found.")
    const profile = this.requireProfile(input.profileId)
    const accounts = [...new Set(input.accountIds)].map((id) => this.requireAccount(id))
    const profileClient = clientIdOf(profile.clientId)
    if (accounts.some((account) => clientIdOf(account.clientId) !== profileClient)) {
      throw new AppError("The profile and the account have to belong to the same client.")
    }
    const quantity = Math.round(Number(input.quantity))
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) throw new AppError("Quantity must be from 1 to 12.")
    const planned = calendarTaskInputs({
      event,
      accounts,
      profileId: input.profileId,
      quantity,
      testMode: input.testMode === true,
      confirmPurchase: input.confirmPurchase === true && input.testMode !== true
    })
    if (!planned.length) throw new AppError("Choose an account for this store.")
    if (planned.length > 50) throw new AppError("Create at most 50 tasks at once.")
    const tasks = planned.map((item) => this.saveTask(item))
    const schedule = this.saveSchedule({
      name: event.name,
      enabled: true,
      startAt: event.startAt,
      warmupMin: input.warmupMin,
      rehearsalMin: input.rehearsalMin,
      taskIds: tasks.map((task) => task.id),
      group: event.name.slice(0, 40)
    })
    return { tasks, schedule }
  }

  recordCheckout(input: Omit<CheckoutRecord, "id" | "at" | "price" | "detail"> & { detail: string; price?: number | null }): CheckoutRecord {
    const detail = redact(input.detail).slice(0, 240)
    const record: CheckoutRecord = {
      id: randomUUID(),
      at: Date.now(),
      store: input.store,
      sku: input.sku.slice(0, 180),
      product: (input.product || input.sku).slice(0, 180),
      price: input.price === undefined ? priceFromDetail(detail) : input.price,
      outcome: input.outcome,
      profileName: input.profileName.slice(0, 80),
      orderId: input.orderId?.slice(0, 80),
      accountId: input.accountId,
      profileId: input.profileId,
      quantity: input.quantity,
      last4: cardLast4(input.last4),
      clientId: input.clientId ? clientIdOf(input.clientId) : undefined,
      detail
    }
    if (!this.data.checkouts) this.data.checkouts = []
    this.data.checkouts.unshift(record)
    this.data.checkouts = this.data.checkouts.slice(0, 400)
    this.flush()
    return { ...record }
  }

  healthWorld(): HealthWorld {
    const settings = this.getSettings()
    return {
      profiles: this.listProfiles().map((profile) => ({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        cardName: profile.cardName,
        last4: profile.last4,
        clientId: profile.clientId,
        shipping: profile.shipping,
        billing: profile.billing
      })),
      accounts: this.listAccounts().map((account) => ({
        id: account.id,
        clientId: account.clientId,
        hasSession: account.hasSession,
        sessionState: account.sessionState,
        lastWarmAt: account.lastWarmAt
      })),
      tasks: this.listTasks().map((task) => ({
        id: task.id,
        store: task.store,
        sku: task.sku,
        quantity: task.quantity,
        clientId: task.clientId,
        profileId: task.profileId,
        accountId: task.accountId,
        kind: task.kind,
        monitorOnly: task.monitorOnly,
        status: task.status
      })),
      checkouts: this.listCheckouts().map((record) => ({
        outcome: record.outcome,
        store: record.store,
        sku: record.sku,
        quantity: record.quantity,
        clientId: record.clientId,
        profileId: record.profileId,
        last4: record.last4,
        at: record.at
      })),
      declines: (this.data.declines ?? []).map((row) => ({ ...row })),
      now: Date.now(),
      freshMin: settings.sessionWarmupMin,
      block: settings.checkoutHealthBlock === true,
      skuLimit: settings.clientSkuLimit,
      declineHoldMin: settings.declineHoldMin,
      addressOrderLimits: settings.addressOrderLimits,
      addressWindowStart: activeDropStart(this.listSchedules(), Date.now()) ?? startOfLocalDay(Date.now(), settings.healthReportZone),
      moduleAddressCaps: { ...this.moduleAddressCaps }
    }
  }

  setModuleAddressCaps(caps: HealthWorld["moduleAddressCaps"]): void {
    this.moduleAddressCaps = { ...caps }
  }

  assessTask(id: string): HealthReport {
    const task = this.requireTask(id)
    if (task.kind === "monitor" || task.monitorOnly === true) return { issues: [], blocked: false }
    return assessCheckout(this.healthWorld(), {
      taskId: task.id,
      store: task.store,
      sku: task.sku,
      quantity: task.quantity,
      profileId: task.profileId,
      accountId: task.accountId,
      clientId: task.clientId
    })
  }

  previewCheckoutHealth(input: CheckoutSubject): HealthReport {
    const store = assertStore(input.store)
    const quantity = Math.round(Number(input.quantity))
    const clamped = Number.isInteger(quantity) && quantity >= 1 && quantity <= 12 ? quantity : 1
    return assessCheckout(this.healthWorld(), {
      store,
      sku: typeof input.sku === "string" ? input.sku : "",
      quantity: clamped,
      profileId: input.profileId || undefined,
      accountId: input.accountId || undefined,
      clientId: input.clientId || undefined,
      taskId: input.taskId || undefined
    })
  }

  clientCheckoutHealth(clientId: string): HealthReport {
    this.requireClient(clientIdOf(clientId))
    return assessClient(this.healthWorld(), clientId)
  }

  listTaskHealth(): Array<{ taskId: string; issues: HealthIssue[] }> {
    const world = this.healthWorld()
    const rows: Array<{ taskId: string; issues: HealthIssue[] }> = []
    for (const task of world.tasks) {
      if (task.kind === "monitor" || task.monitorOnly) continue
      const report = assessCheckout(world, {
        taskId: task.id,
        store: task.store,
        sku: task.sku,
        quantity: task.quantity,
        profileId: task.profileId,
        accountId: task.accountId,
        clientId: task.clientId
      })
      if (report.issues.length) rows.push({ taskId: task.id, issues: report.issues })
    }
    return rows
  }

  recordDecline(input: { taskId: string; last4: string; store: StoreId; sku: string }): CardDecline | null {
    const last4 = /^\d{4}$/.test(input.last4) ? input.last4 : ""
    if (!last4 || !input.taskId) return null
    const row: CardDecline = {
      taskId: input.taskId.slice(0, 80),
      last4,
      at: Date.now(),
      store: assertStore(input.store),
      sku: (input.sku || "").slice(0, 180)
    }
    const rest = (this.data.declines ?? []).filter((item) => !(item.taskId === row.taskId && item.last4 === row.last4))
    rest.unshift(row)
    this.data.declines = rest.slice(0, 200)
    this.flush()
    return { ...row }
  }

  listClients(): Client[] {
    return (this.data.clients ?? []).map((client) => ({ ...client }))
  }

  clientById(id: string): Client | undefined {
    const found = (this.data.clients ?? []).find((client) => client.id === clientIdOf(id))
    return found ? { ...found } : undefined
  }

  summarizeClients(): ClientSummary[] {
    const rows = this.data.ledger ?? []
    return this.listClients().map((client) => clientSummary(client, rows))
  }

  private requireClient(id: string): Client {
    const found = (this.data.clients ?? []).find((client) => client.id === id)
    if (!found) throw new AppError("That client was not found.")
    return found
  }

  saveClient(input: ClientInput): Client {
    const name = (input.name ?? "").trim()
    if (!name) throw new AppError("Client name is required.")
    const existing = input.id ? this.requireClient(input.id) : undefined
    const fee = roundMoney(Number(input.fee ?? existing?.fee ?? 0))
    if (!Number.isFinite(fee) || fee < 0 || fee > 10000) throw new AppError("Fee has to be from 0 to 10000.")
    const basis = input.feeBasis ?? existing?.feeBasis ?? "success"
    if (basis !== "success" && basis !== "item") throw new AppError("Fee basis has to be per success or per item.")
    const status = input.status ?? existing?.status ?? "active"
    if (status !== "active" && status !== "paused") throw new AppError("Client status has to be active or paused.")
    const webhook = (input.webhook ?? existing?.webhook ?? "").trim()
    assertDiscordWebhook(webhook)
    const client: Client = {
      id: existing?.id ?? randomUUID(),
      name: name.slice(0, 80),
      contact: (input.contact ?? "").trim().slice(0, 120),
      notes: (input.notes ?? "").trim().slice(0, 1000),
      feeBasis: basis,
      fee,
      status,
      webhook,
      createdAt: existing?.createdAt ?? Date.now()
    }
    if (!this.data.clients) this.data.clients = [meClient()]
    if (existing) this.data.clients = this.data.clients.map((item) => (item.id === client.id ? client : item))
    else this.data.clients.push(client)
    this.flush()
    return { ...client }
  }

  deleteClient(id: string): { accountIds: string[] } {
    if (id === ME_CLIENT_ID) throw new AppError("The Me client stays on this PC.")
    const client = (this.data.clients ?? []).find((item) => item.id === id)
    if (!client) throw new AppError("That client was not found.")
    const accountIds = this.data.accounts.filter((account) => clientIdOf(account.clientId) === client.id).map((account) => account.id)
    const accountSet = new Set(accountIds)
    const profileIds = new Set(this.data.profiles.filter((profile) => clientIdOf(profile.clientId) === client.id).map((profile) => profile.id))
    const active = this.data.tasks.some((task) => isActiveStatus(task.status) && (clientIdOf(task.clientId) === client.id || (task.accountId ? accountSet.has(task.accountId) : false)))
    if (active) throw new AppError("Stop this client's tasks before deleting their data.")
    const removedTasks = new Set(this.data.tasks.filter((task) => clientIdOf(task.clientId) === client.id || (task.accountId && accountSet.has(task.accountId)) || (task.profileId && profileIds.has(task.profileId))).map((task) => task.id))
    this.data.tasks = this.data.tasks.filter((task) => !removedTasks.has(task.id))
    this.data.declines = (this.data.declines ?? []).filter((row) => !removedTasks.has(row.taskId))
    this.data.profiles = this.data.profiles.filter((profile) => !profileIds.has(profile.id))
    this.data.accounts = this.data.accounts.filter((account) => !accountSet.has(account.id))
    this.data.ledger = (this.data.ledger ?? []).filter((row) => row.clientId !== client.id)
    this.data.clients = (this.data.clients ?? []).filter((item) => item.id !== client.id)
    this.data.vault = (this.data.vault ?? []).filter((link) => !accountSet.has(link.accountId))
    if (this.data.hygiene) this.data.hygiene.pins = this.data.hygiene.pins.filter((pin) => !accountSet.has(pin.accountId))
    this.flush()
    return { accountIds }
  }

  /** Caller asked to download this client's own card and address. Do not log the result. */
  exportClient(id: string): ClientExport {
    const client = this.requireClient(clientIdOf(id))
    return {
      client: { ...client },
      profiles: this.data.profiles.filter((record) => clientIdOf(record.clientId) === client.id).map((record) => {
        const open = this.openProfile(record)
        return {
          id: open.id,
          name: open.name,
          email: open.email,
          phone: open.phone,
          shipping: open.shipping,
          billing: open.billing,
          cardName: open.cardName,
          last4: open.last4,
          expMonth: open.expMonth,
          expYear: open.expYear,
          clientId: clientIdOf(open.clientId),
          card: this.decryptCard(record)
        }
      }),
      accounts: this.data.accounts.filter((record) => clientIdOf(record.clientId) === client.id).map((record) => ({
        store: record.store,
        label: record.label,
        username: record.username
      }))
    }
  }

  listLedger(clientId?: string): LedgerEntry[] {
    const id = clientId ? clientIdOf(clientId) : ""
    return (this.data.ledger ?? []).filter((row) => !id || row.clientId === id).map((row) => ({ ...row }))
  }

  recordLedger(input: { clientId: string; store: StoreId; sku: string; product: string; quantity: number; price: number | null; orderId?: string }): LedgerEntry {
    const client = this.requireClient(clientIdOf(input.clientId))
    const store = assertStore(input.store)
    const quantity = Math.round(Number(input.quantity))
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) throw new AppError("Quantity must be from 1 to 12.")
    const price = input.price === null || input.price === undefined || !Number.isFinite(Number(input.price)) ? null : roundMoney(Number(input.price))
    const entry: LedgerEntry = {
      id: randomUUID(),
      at: Date.now(),
      clientId: client.id,
      clientName: client.name,
      store,
      sku: (input.sku || "").slice(0, 180),
      product: (input.product || input.sku || "").slice(0, 180),
      quantity,
      price,
      orderId: (input.orderId ?? "").slice(0, 80),
      fee: feeOwed(client, quantity),
      paid: false,
      paidAt: null
    }
    if (!this.data.ledger) this.data.ledger = []
    this.data.ledger.unshift(entry)
    this.data.ledger = this.data.ledger.slice(0, 2000)
    this.flush()
    return { ...entry }
  }

  markLedgerPaid(clientId: string, ids: string[], paid: boolean): LedgerEntry[] {
    const client = this.requireClient(clientIdOf(clientId))
    const wanted = new Set((ids ?? []).filter((id) => typeof id === "string" && id))
    const now = Date.now()
    for (const row of this.data.ledger ?? []) {
      if (row.clientId !== client.id) continue
      const hit = wanted.size === 0 ? (paid ? !row.paid : row.paid) : wanted.has(row.id)
      if (!hit) continue
      row.paid = paid
      row.paidAt = paid ? now : null
    }
    this.flush()
    return this.listLedger(client.id)
  }

  ledgerExport(clientId?: string): string {
    return ledgerCsvText(this.listLedger(clientId))
  }

  analytics(): AnalyticsReport {
    const report = summarize(this.data.checkouts ?? [])
    report.monitor = summarizeMonitor(this.data.monitorSamples ?? [])
    report.stockLog = (this.data.stockLog ?? []).slice(0, 40)
    report.restockHints = suggestWarmups(this.data.stockLog ?? [])
    return report
  }

  recordMonitor(sample: MonitorSample): void {
    if (!this.data.monitorSamples) this.data.monitorSamples = []
    this.data.monitorSamples.unshift(sample)
    this.data.monitorSamples = this.data.monitorSamples.slice(0, 500)
    this.flush()
  }

  lastRestockPrice(store: StoreId, sku: string): number | null {
    const found = (this.data.stockLog ?? []).find((event) => event.store === store && event.sku === sku && event.price !== null)
    return found?.price ?? null
  }

  recordRestock(event: RestockEvent): void {
    if (!this.data.stockLog) this.data.stockLog = []
    this.data.stockLog.unshift(event)
    this.data.stockLog = this.data.stockLog.slice(0, 400)
    this.flush()
  }

  checkoutCsv(): string {
    return checkoutCsv(this.data.checkouts ?? [])
  }

  setUpdateToken(action: "keep" | "replace" | "clear", token: string): void {
    const updates = this.updates()
    if (action === "clear") updates.tokenSecret = undefined
    if (action === "replace") {
      const trimmed = token.trim()
      if (trimmed.length < 8 || /[\r\n\s]/.test(trimmed)) throw new AppError("GitHub token is invalid.")
      updates.tokenSecret = this.cipher.encrypt(trimmed)
    }
    this.flush()
  }

  hasUpdateToken(): boolean {
    return Boolean(this.data.updates?.tokenSecret)
  }

  updateToken(): string {
    const secret = this.data.updates?.tokenSecret
    return secret ? this.cipher.decrypt(secret) : ""
  }

  setBackupToken(action: "keep" | "replace" | "clear", token: string): void {
    if (!this.data.backup) this.data.backup = {}
    if (action === "clear") this.data.backup.tokenSecret = undefined
    if (action === "replace") {
      const trimmed = token.trim()
      if (trimmed.length < 8 || /[\r\n\s]/.test(trimmed)) throw new AppError("Backup token is invalid.")
      this.data.backup.tokenSecret = this.cipher.encrypt(trimmed)
    }
    this.flush()
  }

  hasBackupToken(): boolean {
    return Boolean(this.data.backup?.tokenSecret)
  }

  licenseView(): {
    machineId: string
    publicKey: string
    hasPrivateKey: boolean
    hasAdmin: boolean
    activated: boolean
    holder: string
    expiresAt: number | null
    seats: number
    issued: IssuedLicense[]
  } {
    const file = this.data.license
    const activation = file?.activation
    const active = Boolean(activation && activation.machineId === this.data.pcId && (activation.expiresAt === null || activation.expiresAt > Date.now()))
    return {
      machineId: this.data.pcId,
      publicKey: this.getSettings().licensePublicKey,
      hasPrivateKey: Boolean(file?.privateSecret),
      hasAdmin: Boolean(file?.adminSecret),
      activated: active,
      holder: activation?.holder ?? "",
      expiresAt: activation?.expiresAt ?? null,
      seats: activation?.seats ?? 0,
      issued: (file?.issued ?? []).map((row) => ({
        id: row.id,
        holder: row.holder,
        seats: row.seats,
        expiresAt: row.expiresAt,
        revoked: row.revoked,
        machines: [...row.machines]
      }))
    }
  }

  generateLicenseIdentity(): { publicKey: string } {
    const identity = createLicenseIdentity()
    const file = this.licenseFile()
    file.publicKey = identity.publicKey
    file.privateSecret = this.cipher.encrypt(identity.privateKey)
    this.saveSettings({ ...this.getSettings(), licensePublicKey: identity.publicKey })
    return { publicKey: identity.publicKey }
  }

  setLicenseAdmin(action: "keep" | "replace" | "clear", token: string): void {
    const file = this.licenseFile()
    if (action === "clear") file.adminSecret = undefined
    if (action === "replace") {
      const trimmed = token.trim()
      if (trimmed.length < 8 || /[\r\n\s]/.test(trimmed)) throw new AppError("Admin token is invalid.")
      file.adminSecret = this.cipher.encrypt(trimmed)
    }
    this.flush()
  }

  licenseAdminToken(): string {
    const secret = this.data.license?.adminSecret
    return secret ? this.cipher.decrypt(secret) : ""
  }

  mintLicense(input: { holder: string; seats: number; expiresAt: number | null }): { id: string; key: string } {
    const file = this.licenseFile()
    if (!file.privateSecret) throw new AppError("Generate a license identity on this PC first.")
    const signed = signLicense(this.cipher.decrypt(file.privateSecret), input)
    file.issued.unshift({
      id: signed.payload.id,
      holder: signed.payload.holder,
      seats: signed.payload.seats,
      expiresAt: signed.payload.exp,
      revoked: false,
      machines: [],
      tokenSecret: this.cipher.encrypt(signed.token)
    })
    this.flush()
    return { id: signed.payload.id, key: signed.token }
  }

  licenseToken(id: string): string {
    const row = this.licenseFile().issued.find((item) => item.id === id)
    if (!row) throw new AppError("That license was not found.")
    return this.cipher.decrypt(row.tokenSecret)
  }

  revokeLicense(id: string): void {
    const row = this.licenseFile().issued.find((item) => item.id === id)
    if (!row) throw new AppError("That license was not found.")
    row.revoked = true
    if (this.data.license?.activation?.licenseId === id) this.data.license.activation = undefined
    this.flush()
  }

  activateLicense(key: string): LicenseStatus {
    const publicKey = this.getSettings().licensePublicKey || this.licenseFile().publicKey
    if (!publicKey) throw new AppError("A license is optional for personal use. Add a public key only if you turned on Require a license.")
    const payload = readLicense(key, publicKey)
    assertLicenseAllowed(payload)
    const row = this.licenseFile().issued.find((item) => item.id === payload.id)
    if (row) {
      const bound = bindMachine(row, this.data.pcId)
      row.machines = bound.machines
    }
    this.licenseFile().activation = {
      tokenSecret: this.cipher.encrypt(key),
      licenseId: payload.id,
      holder: payload.holder,
      expiresAt: payload.exp,
      seats: payload.seats,
      machineId: this.data.pcId,
      activatedAt: Date.now()
    }
    this.flush()
    return { licenseId: payload.id, holder: payload.holder, expiresAt: payload.exp, seats: payload.seats }
  }

  saveRemoteActivation(key: string, status: LicenseStatus): LicenseStatus {
    this.licenseFile().activation = {
      tokenSecret: this.cipher.encrypt(key),
      licenseId: status.licenseId,
      holder: status.holder,
      expiresAt: status.expiresAt,
      seats: status.seats,
      machineId: this.data.pcId,
      activatedAt: Date.now()
    }
    this.flush()
    return status
  }

  licensePublicKey(): string {
    return this.getSettings().licensePublicKey || this.data.license?.publicKey || ""
  }

  findLicenseToken(key: string): IssuedLicense | null {
    const file = this.data.license
    if (!file) return null
    for (const row of file.issued) {
      if (this.cipher.decrypt(row.tokenSecret) !== key) continue
      return { id: row.id, holder: row.holder, seats: row.seats, expiresAt: row.expiresAt, revoked: row.revoked, machines: [...row.machines] }
    }
    return null
  }

  rememberLicense(record: IssuedLicense, key: string): void {
    const file = this.licenseFile()
    const row = file.issued.find((item) => item.id === record.id)
    if (row) {
      row.holder = record.holder
      row.seats = record.seats
      row.expiresAt = record.expiresAt
      row.revoked = record.revoked
      row.machines = [...record.machines]
    } else {
      file.issued.unshift({ ...record, machines: [...record.machines], tokenSecret: this.cipher.encrypt(key) })
    }
    this.flush()
  }

  licenseAllows(): boolean {
    if (!this.getSettings().licenseRequired) return true
    const activation = this.data.license?.activation
    if (!activation || activation.machineId !== this.data.pcId) return false
    if (activation.expiresAt !== null && activation.expiresAt <= Date.now()) return false
    const row = this.data.license?.issued.find((item) => item.id === activation.licenseId)
    if (row?.revoked) return false
    return true
  }

  private licenseFile(): LicenseFile {
    if (!this.data.license) this.data.license = emptyLicense()
    return this.data.license
  }

  backupToken(): string {
    const secret = this.data.backup?.tokenSecret
    return secret ? this.cipher.decrypt(secret) : ""
  }

  backupFile(passphrase: string): string {
    return sealBackup(this.backupDocument(), passphrase)
  }

  restoreFile(file: string, passphrase: string): void {
    this.restoreBackup(openBackup(file, passphrase))
  }

  backupDocument(): BackupDocument {
    return {
      v: 1,
      settings: this.getSettings(),
      tasks: this.listTasks().map((task) => {
        const active = isActiveStatus(task.status)
        return {
          ...cloneTask(task),
          status: active ? "paused" : task.status,
          detail: active ? "Paused for backup." : task.detail,
          logs: task.logs.slice(-20).map((line) => ({ ...line, message: redact(line.message).slice(0, 240) }))
        }
      }),
      profiles: this.data.profiles.map((record) => {
        const open = this.openProfile(record)
        return {
          id: open.id,
          name: open.name,
          email: open.email,
          phone: open.phone,
          shipping: open.shipping,
          billing: open.billing,
          cardName: open.cardName,
          last4: open.last4,
          expMonth: open.expMonth,
          expYear: open.expYear,
          card: this.decryptCard(record),
          clientId: open.clientId
        }
      }),
      accounts: this.data.accounts.map((record) => ({
        id: record.id,
        store: record.store,
        label: record.label,
        username: record.username,
        password: record.passwordSecret ? this.cipher.decrypt(record.passwordSecret) : undefined,
        session: record.sessionSecret ? (JSON.parse(this.cipher.decrypt(record.sessionSecret)) as SessionCookies) : undefined,
        proxyGroupId: record.proxyGroupId ?? null,
        sessionState: record.sessionState ?? "missing",
        lastWarmAt: record.lastWarmAt ?? null,
        clientId: clientIdOf(record.clientId)
      })),
      proxyGroups: this.listProxyGroups(),
      schedules: this.listSchedules(),
      templates: this.listTemplates(),
      clients: this.listClients(),
      ledger: this.listLedger()
    }
  }

  restoreBackup(doc: BackupDocument): void {
    if (!doc || doc.v !== 1) throw new AppError("This backup was written by a newer TCGAIO version.")
    const snapshot = structuredClone(this.data)
    try {
      const keptPc = this.data.pcId
      const devices = this.data.devices.map((device) => ({ ...device }))
      const updates = this.data.updates ? { ...this.data.updates } : undefined
      const backup = this.data.backup ? { ...this.data.backup } : undefined
      const checkouts = (this.data.checkouts ?? []).map((row) => ({ ...row }))
      this.data.settings = cleanSettings({ ...DEFAULT_SETTINGS, ...doc.settings })
      this.data.profiles = (doc.profiles ?? []).slice(0, 200).map((profile) => this.profileFromBackup(profile))
      this.data.accounts = (doc.accounts ?? []).slice(0, 200).map((account) => this.accountFromBackup(account))
      this.data.proxyGroups = (doc.proxyGroups ?? []).slice(0, 50).map((group) => cleanBackupProxy(group))
      const knownProxies = new Set(this.data.proxyGroups.map((group) => group.id))
      for (const account of this.data.accounts) {
        if (account.proxyGroupId && !knownProxies.has(account.proxyGroupId)) account.proxyGroupId = null
      }
      for (const account of this.data.accounts) {
        const taken = proxyGroupTakenBy(
          this.data.accounts.map((item) => ({ id: item.id, clientId: item.clientId, proxyGroupId: item.proxyGroupId ?? null })),
          account.id,
          clientIdOf(account.clientId),
          account.proxyGroupId ?? null
        )
        if (taken) throw new AppError("That proxy group already belongs to another client. Each client needs their own proxy group.")
      }
      const tasks: PublicTask[] = []
      this.data.tasks = []
      for (const raw of (doc.tasks ?? []).slice(0, 400)) {
        if (!raw || typeof raw.id !== "string") throw new AppError("A task in the backup is incomplete.")
        const input = taskInputFromBackup(raw)
        if (input.proxyGroupId && !knownProxies.has(input.proxyGroupId)) input.proxyGroupId = null
        if (input.monitorProxyGroupId && !knownProxies.has(input.monitorProxyGroupId)) input.monitorProxyGroupId = null
        const stub: PublicTask = {
          ...raw,
          status: "idle",
          detail: "Restored from backup.",
          logs: Array.isArray(raw.logs) ? raw.logs.slice(-20) : [],
          createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now()
        }
        tasks.push(this.taskFrom(input, stub))
      }
      this.data.tasks = tasks
      for (const task of tasks) this.syncLinks(task)
      const schedules = normalizeSchedules(doc.schedules)
      const taskIds = new Set(tasks.map((task) => task.id))
      this.data.schedules = schedules.map((schedule) => ({
        ...schedule,
        taskIds: schedule.taskIds.filter((id) => taskIds.has(id))
      })).filter((schedule) => schedule.taskIds.length || schedule.group)
      this.data.templates = (doc.templates ?? []).slice(0, 50).map((template) => this.templateFromBackup(template))
      this.data.pcId = keptPc
      this.data.devices = devices
      this.data.updates = updates
      this.data.backup = backup
      this.data.checkouts = checkouts
      this.data.clients = Array.isArray(doc.clients) ? normalizeClients(doc.clients) : normalizeClients(this.data.clients)
      this.data.ledger = Array.isArray(doc.ledger) ? normalizeLedger(doc.ledger) : normalizeLedger(this.data.ledger)
      this.flush()
    } catch (err) {
      this.data = snapshot
      throw err
    }
  }

  private profileFromBackup(input: BackupProfile): ProfileRecord {
    if (!input?.card) throw new AppError("A profile in the backup is missing its card.")
    const shipping = cleanAddress(input.shipping, "Shipping")
    const billing = cleanAddress(input.billing, "Billing")
    const name = (input.name ?? "").trim()
    if (!name) throw new AppError("Profile name is required.")
    const card = cleanCard(
      { cardName: input.card.name, cardNumber: input.card.number, expMonth: input.card.expMonth, expYear: input.card.expYear, cvv: input.card.cvv },
      name
    )
    const email = cleanEmail(input.email)
    const phone = cleanPhone(input.phone)
    return {
      id: safeId(input.id),
      name,
      cardName: card.name,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      cardSecret: this.cipher.encrypt(JSON.stringify(cardSecretFrom(card))),
      piiSecret: this.cipher.encrypt(JSON.stringify({ email, phone, shipping, billing } satisfies ProfilePii)),
      clientId: clientIdOf(input.clientId)
    }
  }

  private accountFromBackup(input: BackupAccount): AccountRecord {
    const store = assertStore(input.store)
    const label = (input.label ?? "").trim()
    if (!label) throw new AppError("Account label is required.")
    const passwordSecret = input.password ? this.cipher.encrypt(input.password) : undefined
    const sessionSecret = input.session ? this.cipher.encrypt(JSON.stringify(parseSession(JSON.stringify(input.session)))) : undefined
    return {
      id: safeId(input.id),
      store,
      label,
      username: cleanEmail(input.username),
      passwordSecret,
      sessionSecret,
      proxyGroupId: input.proxyGroupId || null,
      sessionState: sessionSecret ? input.sessionState === "expired" ? "expired" : "saved" : "missing",
      lastWarmAt: typeof input.lastWarmAt === "number" ? input.lastWarmAt : null,
      clientId: clientIdOf(input.clientId)
    }
  }

  private templateFromBackup(input: TaskTemplate): TaskTemplate {
    const name = (input?.name ?? "").trim()
    if (!name) throw new AppError("Template name is required.")
    const store = input.store ? assertStore(input.store) : ""
    const profileIds = [...new Set((input.profileIds ?? []).filter(Boolean))]
    const accountIds = [...new Set((input.accountIds ?? []).filter(Boolean))]
    if (!profileIds.length || !accountIds.length) throw new AppError("A template in the backup needs a profile and an account.")
    for (const id of profileIds) this.requireProfile(id)
    for (const id of accountIds) {
      const account = this.requireAccount(id)
      if (store && account.store !== store) throw new AppError("A template account does not match its store.")
    }
    if (input.proxyGroupId && !this.data.proxyGroups.some((group) => group.id === input.proxyGroupId)) {
      input = { ...input, proxyGroupId: null }
    }
    const quantity = Math.round(Number(input.quantity))
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) throw new AppError("Quantity must be from 1 to 12.")
    const sku = (input.sku ?? "").trim().slice(0, 180)
    const keywords = (input.keywords ?? "").trim().slice(0, 200)
    if (!sku && !keywords) throw new AppError("A template needs a SKU or keywords.")
    return {
      id: safeId(input.id),
      name: name.slice(0, 80),
      enabled: input.enabled !== false,
      store,
      sku,
      keywords,
      profileIds,
      accountIds,
      proxyGroupId: input.proxyGroupId || null,
      monitorProxyGroupId: input.monitorProxyGroupId || null,
      quantity,
      maxPrice: input.maxPrice === null || input.maxPrice === undefined ? null : Number(input.maxPrice),
      testMode: input.testMode === true,
      confirmPurchase: input.confirmPurchase === true,
      group: (input.group ?? "").trim().slice(0, 40),
      lastFiredAt: typeof input.lastFiredAt === "number" ? input.lastFiredAt : 0
    }
  }

  saveUpdateNotice(notice: { desktopVersion: string | null; phoneVersion: string | null; notes: string }): void {
    const updates = this.updates()
    updates.desktopVersion = notice.desktopVersion
    updates.phoneVersion = notice.phoneVersion
    updates.notes = notice.notes.slice(0, 4000)
    updates.checkedAt = Date.now()
    this.flush()
  }

  updateNotice(): { desktopVersion: string | null; phoneVersion: string | null; notes: string } {
    const updates = this.data.updates
    return {
      desktopVersion: updates?.desktopVersion ?? null,
      phoneVersion: updates?.phoneVersion ?? null,
      notes: updates?.notes ?? ""
    }
  }

  private updates(): UpdateFile {
    if (!this.data.updates) this.data.updates = emptyUpdates()
    return this.data.updates
  }

  pcId(): string {
    return this.data.pcId
  }

  listDevices(): { id: string; name: string; createdAt: number; lastSeenAt: number }[] {
    return this.data.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt }))
  }

  deviceTokens(): { id: string; name: string; token: string }[] {
    return this.data.devices.map((device) => ({
      id: device.id,
      name: device.name,
      token: this.cipher.decrypt(device.tokenSecret)
    }))
  }

  saveDevice(input: { id: string; name: string; token: string }): void {
    if (this.data.devices.some((device) => device.id === input.id)) throw new AppError("That phone is already paired.")
    if (this.data.devices.length >= 20) throw new AppError("Revoke a phone before pairing another. The limit is 20.")
    this.data.devices.push({
      id: input.id,
      name: input.name,
      tokenSecret: this.cipher.encrypt(input.token),
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    })
    this.flush()
  }

  revokeDevice(id: string): void {
    const next = this.data.devices.filter((device) => device.id !== id)
    if (next.length === this.data.devices.length) throw new AppError("That phone is not paired.")
    this.data.devices = next
    this.data.vault = (this.data.vault ?? []).filter((link) => link.deviceId !== id)
    this.flush()
  }

  touchDevice(id: string): void {
    const device = this.data.devices.find((item) => item.id === id)
    if (!device) return
    device.lastSeenAt = Date.now()
    this.flush()
  }

  deleteTask(id: string): void {
    const task = this.requireTask(id)
    if (isActiveStatus(task.status)) throw new AppError("Stop the task before deleting it.")
    this.data.tasks = this.data.tasks.filter((item) => item.id !== id)
    this.flush()
  }

  getTask(id: string): PublicTask {
    return cloneTask(this.requireTask(id))
  }

  patchTask(id: string, patch: Partial<Pick<PublicTask, "status" | "detail" | "startedAt" | "finishedAt" | "monitorMs" | "detectToCartMs" | "imageUrl">> & { log?: PublicTask["logs"][number]; resetLogs?: boolean }): PublicTask {
    const task = this.requireTask(id)
    if (patch.resetLogs) task.logs = []
    if (patch.status) task.status = patch.status
    if (patch.detail !== undefined) task.detail = patch.detail
    if ("startedAt" in patch) task.startedAt = patch.startedAt
    if ("finishedAt" in patch) task.finishedAt = patch.finishedAt
    if (typeof patch.monitorMs === "number") task.monitorMs = patch.monitorMs
    if (typeof patch.detectToCartMs === "number") task.detectToCartMs = patch.detectToCartMs
    if (patch.imageUrl) task.imageUrl = patch.imageUrl
    if (patch.log) {
      task.logs.push(patch.log)
      if (task.logs.length > 300) task.logs.splice(0, task.logs.length - 300)
    }
    this.flush()
    return cloneTask(task)
  }

  restockToken(): string {
    const secret = this.restock().tokenSecret
    if (!secret) return ""
    return this.cipher.decrypt(secret)
  }

  rotateRestockToken(): string {
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 16)
    this.restock().tokenSecret = this.cipher.encrypt(token)
    this.flush()
    return token
  }

  discordWatchConfig(): { enabled: boolean; channelId: string; channelIds: string[]; token: string; lastMessageId: string; hasBot: boolean; allowlist: string; dedupeMin: number } {
    const restock = this.restock()
    const channelIds = discordChannels(restock)
    return {
      enabled: restock.discordWatch,
      channelId: channelIds[0] ?? "",
      channelIds,
      token: restock.discordBotSecret ? this.cipher.decrypt(restock.discordBotSecret) : "",
      lastMessageId: restock.lastDiscordMessageId,
      hasBot: Boolean(restock.discordBotSecret),
      allowlist: restock.alertAllowlist ?? "",
      dedupeMin: typeof restock.alertDedupeMin === "number" ? restock.alertDedupeMin : 30
    }
  }

  saveDiscordWatch(input: DiscordWatchInput): void {
    const listed = channelIdsFrom(`${input.channelId ?? ""}\n${input.channelIds ?? ""}`)
    if (input.enabled && !listed.length) throw new AppError("Enter the Discord channel ID before turning the watcher on.")
    const restock = this.restock()
    const previous = new Set(discordChannels(restock))
    if (input.tokenAction === "clear") restock.discordBotSecret = undefined
    if (input.tokenAction === "replace") {
      const token = input.token.trim()
      if (!token || token.length < 20) throw new AppError("Paste the Discord bot token.")
      restock.discordBotSecret = this.cipher.encrypt(token)
    }
    if (input.enabled && !restock.discordBotSecret) throw new AppError("Save a Discord bot token before turning the watcher on.")
    restock.discordChannelId = listed[0] ?? ""
    restock.discordChannelIds = listed.slice(1)
    const cursors = { ...(restock.discordCursors ?? {}) }
    for (const id of Object.keys(cursors)) {
      if (!listed.includes(id)) delete cursors[id]
    }
    restock.discordCursors = cursors
    if (!previous.has(restock.discordChannelId)) restock.lastDiscordMessageId = ""
    restock.discordWatch = input.enabled === true
    if (!restock.discordWatch) restock.lastDiscordMessageId = ""
    if (input.allowlist !== undefined) restock.alertAllowlist = input.allowlist.trim().slice(0, 2000)
    if (input.dedupeMin !== undefined) {
      const minutes = Math.round(Number(input.dedupeMin))
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new AppError("Dedupe has to be from 0 to 1440 minutes.")
      restock.alertDedupeMin = minutes
    }
    this.flush()
  }

  setDiscordEnabled(enabled: boolean): void {
    this.restock().discordWatch = enabled
    this.flush()
  }

  setDiscordCursor(channelId: string, id: string): void {
    const restock = this.restock()
    if (!restock.discordCursors) restock.discordCursors = {}
    restock.discordCursors[channelId] = id
    if (channelId === restock.discordChannelId) restock.lastDiscordMessageId = id
    this.flush()
  }

  discordCursor(channelId: string): string {
    const restock = this.restock()
    if (channelId === restock.discordChannelId && restock.lastDiscordMessageId) return restock.lastDiscordMessageId
    return restock.discordCursors?.[channelId] ?? ""
  }

  alertSeen(): { key: string; at: number }[] {
    return (this.restock().alertSeen ?? []).map((item) => ({ ...item }))
  }

  rememberAlerts(seen: { key: string; at: number }[]): void {
    this.restock().alertSeen = seen.slice(0, 200)
    this.flush()
  }

  listRestockRules(): RestockRule[] {
    return this.restock().rules.map(cloneRule)
  }

  saveRestockRule(input: RestockRuleInput): RestockRule {
    const existing = input.id ? this.restock().rules.find((rule) => rule.id === input.id) : undefined
    const rule = cleanRule(input, existing, this)
    if (existing) this.restock().rules = this.restock().rules.map((item) => (item.id === rule.id ? rule : item))
    else this.restock().rules.unshift(rule)
    this.flush()
    return cloneRule(rule)
  }

  deleteRestockRule(id: string): void {
    const next = this.restock().rules.filter((rule) => rule.id !== id)
    if (next.length === this.restock().rules.length) throw new AppError("That restock rule was not found.")
    this.restock().rules = next
    this.flush()
  }

  touchRestockRule(id: string, ts: number): void {
    const rule = this.restock().rules.find((item) => item.id === id)
    if (!rule) return
    rule.lastFiredAt = ts
    this.flush()
  }

  listWatches(): KeywordWatch[] {
    return this.restock().watches.map(cloneWatch)
  }

  saveWatch(input: KeywordWatchInput): KeywordWatch {
    const existing = input.id ? this.restock().watches.find((watch) => watch.id === input.id) : undefined
    const watch = cleanWatch(input, existing, this)
    if (existing) this.restock().watches = this.restock().watches.map((item) => (item.id === watch.id ? watch : item))
    else this.restock().watches.unshift(watch)
    this.flush()
    return cloneWatch(watch)
  }

  deleteWatch(id: string): void {
    const next = this.restock().watches.filter((watch) => watch.id !== id)
    if (next.length === this.restock().watches.length) throw new AppError("That keyword watch was not found.")
    this.restock().watches = next
    this.flush()
  }

  patchWatch(id: string, patch: Partial<Pick<KeywordWatch, "status" | "detail" | "seenSkus" | "enabled">>): KeywordWatch {
    const watch = this.restock().watches.find((item) => item.id === id)
    if (!watch) throw new AppError("That keyword watch was not found.")
    if (patch.status) watch.status = patch.status
    if (patch.detail !== undefined) watch.detail = patch.detail.slice(0, 240)
    if (patch.seenSkus) watch.seenSkus = patch.seenSkus.slice(-300)
    if (patch.enabled !== undefined) watch.enabled = patch.enabled
    this.flush()
    return cloneWatch(watch)
  }

  resumeWatch(id: string): KeywordWatch {
    const watch = this.patchWatch(id, { status: "idle", detail: "Resumed. The next search uses the next proxy.", enabled: true })
    return watch
  }

  listAlertLog(): AlertLog[] {
    return this.restock().log.map((entry) => ({ ...entry }))
  }

  appendAlertLog(entry: Omit<AlertLog, "id">): AlertLog {
    const saved: AlertLog = { ...entry, id: randomUUID(), result: entry.result.slice(0, 300), title: entry.title.slice(0, 180), sku: entry.sku.slice(0, 80) }
    const log = this.restock().log
    log.unshift(saved)
    if (log.length > 80) log.length = 80
    this.flush()
    return { ...saved }
  }

  listVault(now = Date.now()): PublicVault[] {
    const devices = new Map(this.listDevices().map((device) => [device.id, device.name]))
    return (this.data.vault ?? []).flatMap((link) => {
      const account = this.data.accounts.find((item) => item.id === link.accountId)
      if (!account) return []
      const pub = toPublicAccount(account)
      return [{
        accountId: link.accountId,
        store: pub.store,
        label: pub.label,
        sessionState: pub.sessionState,
        deviceId: link.deviceId,
        deviceName: devices.get(link.deviceId) ?? "Removed browser",
        twoWay: link.twoWay === true,
        lastUsedAt: link.lastUsedAt ?? null,
        expiresAt: link.expiresAt ?? null,
        loggedOut: link.loggedOut === true,
        flag: vaultFlag(link, pub.sessionState, now)
      }]
    })
  }

  linkVault(deviceId: string, accountId: string, twoWay: boolean): VaultLink {
    this.requireAccount(accountId)
    if (!this.data.devices.some((device) => device.id === deviceId)) throw new AppError("That browser is not paired.")
    const links = this.data.vault ?? []
    const existing = links.find((link) => link.deviceId === deviceId && link.accountId === accountId)
    const next: VaultLink = {
      accountId,
      deviceId,
      twoWay,
      linkedAt: existing?.linkedAt ?? Date.now(),
      lastUsedAt: existing?.lastUsedAt ?? null,
      expiresAt: existing?.expiresAt ?? null,
      loggedOut: existing?.loggedOut === true,
      alertedDay: existing?.alertedDay ?? ""
    }
    this.data.vault = existing ? links.map((link) => (link === existing ? next : link)) : [next, ...links]
    this.flush()
    return { ...next }
  }

  unlinkVault(deviceId: string, accountId: string): void {
    this.data.vault = (this.data.vault ?? []).filter((link) => !(link.deviceId === deviceId && link.accountId === accountId))
    this.flush()
  }

  vaultLinksFor(accountId: string, twoWayOnly = false): VaultLink[] {
    return (this.data.vault ?? []).filter((link) => link.accountId === accountId && (!twoWayOnly || link.twoWay)).map((link) => ({ ...link }))
  }

  vaultLinks(): VaultLink[] {
    return (this.data.vault ?? []).map((link) => ({ ...link }))
  }

  setVaultTwoWay(deviceId: string, accountId: string, twoWay: boolean): void {
    const link = (this.data.vault ?? []).find((item) => item.deviceId === deviceId && item.accountId === accountId)
    if (!link) throw new AppError("That browser is not linked to this account.")
    link.twoWay = twoWay
    this.flush()
  }

  pushVault(deviceId: string, accountId: string, cookie: string, expiresAt: number | null): void {
    if (!this.data.devices.some((device) => device.id === deviceId)) throw new AppError("That browser was revoked. Pair it again.")
    const link = (this.data.vault ?? []).find((item) => item.deviceId === deviceId && item.accountId === accountId)
    if (!link) throw new AppError("Link this account in the extension before syncing it.")
    const session = parseSession(cookie)
    link.lastUsedAt = Date.now()
    link.expiresAt = expiresAt
    link.loggedOut = false
    link.alertedDay = ""
    this.updateSession(accountId, session, true)
  }

  pullVault(deviceId: string, accountId: string): string {
    if (!this.data.devices.some((device) => device.id === deviceId)) throw new AppError("That browser was revoked. Pair it again.")
    const link = (this.data.vault ?? []).find((item) => item.deviceId === deviceId && item.accountId === accountId)
    if (!link) throw new AppError("Link this account in the extension before syncing it.")
    if (!link.twoWay) throw new AppError("Two-way sync is off for this account.")
    const session = this.readAccount(accountId).session
    if (!session) throw new AppError("This account has no saved session.")
    link.lastUsedAt = Date.now()
    this.flush()
    const header = cookieHeader(session)
    if (!header) throw new AppError("This account has no saved session.")
    return header
  }

  markVaultAlerted(accountId: string, deviceId: string, day: string, loggedOut: boolean): void {
    const link = (this.data.vault ?? []).find((item) => item.deviceId === deviceId && item.accountId === accountId)
    if (!link) return
    link.alertedDay = day
    if (loggedOut) link.loggedOut = true
    this.flush()
  }

  takeInterrupted(): string[] {
    const ids = this.interrupted
    this.interrupted = []
    return ids
  }

  listCheckouts(): CheckoutRecord[] {
    return (this.data.checkouts ?? []).map((record) => ({ ...record }))
  }

  setCheckoutValue(id: string, marketValue: number | null): CheckoutRecord {
    const record = this.data.checkouts?.find((item) => item.id === id && item.outcome === "success")
    if (!record) throw new AppError("That purchase was not found.")
    if (marketValue === null) record.marketValue = null
    else {
      if (!Number.isFinite(marketValue) || marketValue < 0 || marketValue > 100_000) throw new AppError("Current value must be a dollar amount.")
      record.marketValue = Math.round(marketValue * 100) / 100
    }
    this.flush()
    return { ...record }
  }

  listTemplates(): TaskTemplate[] {
    return (this.data.templates ?? []).map((template) => ({ ...template, profileIds: [...template.profileIds], accountIds: [...template.accountIds] }))
  }

  saveTemplate(input: TaskTemplateInput): TaskTemplate {
    const name = input.name.trim()
    if (!name) throw new AppError("Template name is required.")
    const store = input.store ? assertStore(input.store) : ""
    const profileIds = [...new Set(input.profileIds.filter(Boolean))]
    const accountIds = [...new Set(input.accountIds.filter(Boolean))]
    if (!profileIds.length || !accountIds.length) throw new AppError("Choose at least one profile and one account.")
    for (const id of profileIds) this.requireProfile(id)
    for (const id of accountIds) {
      const account = this.requireAccount(id)
      if (store && account.store !== store) throw new AppError("Each account has to match the template store.")
    }
    if (input.proxyGroupId) this.getProxyGroup(input.proxyGroupId)
    if (input.monitorProxyGroupId) this.getProxyGroup(input.monitorProxyGroupId)
    const quantity = Math.round(Number(input.quantity))
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) throw new AppError("Quantity must be from 1 to 12.")
    const maxPrice = input.maxPrice === null || input.maxPrice === undefined || input.maxPrice === ("" as unknown) ? null : Number(input.maxPrice)
    if (maxPrice !== null && (!Number.isFinite(maxPrice) || maxPrice < 0)) throw new AppError("Price cap must be a dollar amount, or blank.")
    const existing = input.id ? this.data.templates?.find((template) => template.id === input.id) : undefined
    const template: TaskTemplate = {
      id: existing?.id ?? randomUUID(),
      name: name.slice(0, 80),
      enabled: input.enabled !== false,
      store,
      sku: input.sku.trim().slice(0, 180),
      keywords: input.keywords.trim().slice(0, 200),
      profileIds,
      accountIds,
      proxyGroupId: input.proxyGroupId || null,
      monitorProxyGroupId: input.monitorProxyGroupId || null,
      quantity,
      maxPrice,
      testMode: input.testMode === true,
      confirmPurchase: input.confirmPurchase === true,
      group: (input.group ?? "").trim().slice(0, 40),
      lastFiredAt: existing?.lastFiredAt ?? 0
    }
    if (!template.sku && !template.keywords) throw new AppError("A template needs a SKU or keywords.")
    if (!this.data.templates) this.data.templates = []
    if (existing) this.data.templates = this.data.templates.map((item) => (item.id === template.id ? template : item))
    else this.data.templates.unshift(template)
    this.flush()
    return { ...template, profileIds: [...template.profileIds], accountIds: [...template.accountIds] }
  }

  deleteTemplate(id: string): void {
    const next = (this.data.templates ?? []).filter((template) => template.id !== id)
    if (next.length === (this.data.templates ?? []).length) throw new AppError("That template was not found.")
    this.data.templates = next
    this.flush()
  }

  touchTemplate(id: string, ts: number): void {
    const template = this.data.templates?.find((item) => item.id === id)
    if (!template) return
    template.lastFiredAt = ts
    this.flush()
  }

  reassignTask(id: string, accountId: string, profileId?: string): PublicTask {
    const task = this.requireTask(id)
    if (isActiveStatus(task.status)) throw new AppError("Stop the task before changing its account.")
    const account = this.requireAccount(accountId)
    if (account.store !== task.store) throw new AppError("Choose an account for the same store.")
    task.accountId = accountId
    if (profileId) {
      this.requireProfile(profileId)
      task.profileId = profileId
    }
    this.flush()
    return cloneTask(task)
  }

  listOrders(): OrderRecord[] {
    return (this.data.orders ?? []).map((order) => ({ ...order }))
  }

  rememberOrder(input: Omit<OrderRecord, "id" | "checkedAt" | "status" | "tracking" | "detail"> & { detail?: string }): OrderRecord {
    const existing = (this.data.orders ?? []).find((order) => order.store === input.store && order.orderId === input.orderId)
    if (existing) return { ...existing }
    const order: OrderRecord = {
      id: randomUUID(),
      at: input.at,
      store: input.store,
      sku: input.sku.slice(0, 180),
      orderId: input.orderId.slice(0, 80),
      accountId: input.accountId,
      profileId: input.profileId,
      status: "placed",
      tracking: "",
      detail: input.detail?.slice(0, 240) ?? "Order placed.",
      checkedAt: 0,
      quantity: input.quantity
    }
    if (!this.data.orders) this.data.orders = []
    this.data.orders.unshift(order)
    this.data.orders = this.data.orders.slice(0, 200)
    this.flush()
    return { ...order }
  }

  noteOrder(id: string, status: OrderStatus, tracking: string, detail: string, carrier = ""): void {
    const order = this.data.orders?.find((item) => item.id === id)
    if (!order) return
    order.status = status
    order.tracking = tracking.slice(0, 40)
    order.carrier = carrier.slice(0, 20)
    order.detail = detail.slice(0, 240)
    order.checkedAt = Date.now()
    this.flush()
  }

  touchOrder(id: string): void {
    const order = this.data.orders?.find((item) => item.id === id)
    if (!order) return
    order.checkedAt = Date.now()
    this.flush()
  }

  heals(): Record<string, number> {
    return { ...(this.data.heals ?? {}) }
  }

  bumpHeal(id: string): number {
    if (!this.data.heals) this.data.heals = {}
    this.data.heals[id] = (this.data.heals[id] ?? 0) + 1
    this.flush()
    return this.data.heals[id]
  }

  learnedKeys(): string[] {
    return [...(this.data.learnedKeys ?? [])]
  }

  markLearned(key: string): void {
    const keys = this.data.learnedKeys ?? []
    if (!keys.includes(key)) keys.unshift(key)
    this.data.learnedKeys = keys.slice(0, 200)
    this.flush()
  }

  reportDay(): string {
    return this.data.reportDay ?? ""
  }

  setReportDay(day: string): void {
    this.data.reportDay = day
    this.flush()
  }

  imapView(): ImapView {
    const first = this.listMailboxes()[0]
    if (!first) return { enabled: false, host: "", port: 993, user: "", mailbox: "INBOX", hasPassword: false }
    return { enabled: first.enabled, host: first.host, port: first.port, user: first.user, mailbox: first.mailbox, hasPassword: first.hasPassword }
  }

  imapLogin(): { host: string; port: number; user: string; mailbox: string; password: string } | null {
    const login = this.mailboxLogins("orders")[0]
    if (!login) return null
    return { host: login.host, port: login.port, user: login.user, mailbox: login.mailbox, password: login.password }
  }

  saveImap(input: ImapInput): ImapView {
    const host = input.host.trim()
    const user = input.user.trim()
    const mailbox = (input.mailbox || "INBOX").trim() || "INBOX"
    const port = Math.round(Number(input.port))
    if (input.enabled && (!host || !user)) throw new AppError("Enter the mail host and username before turning mail tracking on.")
    if (host && !/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new AppError("Mail host must be a hostname.")
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("Mail port must be from 1 to 65535.")
    const boxes = this.mailboxes()
    if (!host && !user && input.passwordAction !== "replace" && !boxes[0]) return this.imapView()
    const row = boxes[0] ?? this.blankMailbox()
    if (!boxes[0]) boxes.push(row)
    this.applyPassword(row, input.password, input.passwordAction)
    if (input.enabled && !row.passwordSecret) throw new AppError("Save the mail password before turning mail tracking on.")
    row.enabled = input.enabled === true
    row.host = host.toLowerCase()
    row.port = port
    row.secure = true
    row.user = user.slice(0, 180)
    row.mailbox = mailbox.slice(0, 80)
    row.provider = providerForHost(host)
    row.orders = true
    if (!row.name || row.name === "Mailbox") row.name = user || "Mailbox"
    this.syncLegacyImap()
    this.flush()
    return this.imapView()
  }

  listMailboxes(): MailboxView[] {
    return this.mailboxes().map((row) => this.toMailboxView(row))
  }

  mailboxStatus(): MailboxStatus {
    const rows = this.listMailboxes()
    const enabled = rows.filter((row) => row.enabled)
    return {
      accounts: rows.length,
      enabled: enabled.length,
      ready: enabled.filter((row) => row.hasPassword && !row.lastError).length,
      lastError: rows.find((row) => row.lastError)?.lastError ?? ""
    }
  }

  saveMailbox(input: MailboxInput): MailboxView {
    const host = input.host.trim().toLowerCase()
    const user = input.user.trim()
    const mailbox = (input.mailbox || "INBOX").trim() || "INBOX"
    const port = Math.round(Number(input.port))
    const provider = isMailProvider(input.provider) ? input.provider : "custom"
    const name = (input.name || user || "Mailbox").trim().slice(0, 80)
    if (!host || !user) throw new AppError("Enter the mail host and username.")
    if (!/^[a-z0-9.-]{1,253}$/.test(host)) throw new AppError("Mail host must be a hostname.")
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("Mail port must be from 1 to 65535.")
    const boxes = this.mailboxes()
    const existing = input.id ? boxes.find((row) => row.id === input.id) : undefined
    if (input.id && !existing) throw new AppError("Mailbox not found.")
    if (!existing && boxes.length >= 8) throw new AppError("Save at most 8 mailboxes.")
    const row = existing ?? this.blankMailbox()
    this.applyPassword(row, input.password, input.passwordAction)
    if (input.enabled && !row.passwordSecret && !row.refreshSecret) throw new AppError("Save the app password, or sign in, before turning this mailbox on.")
    row.name = name
    row.enabled = input.enabled === true
    row.provider = provider
    row.host = host
    row.port = port
    row.secure = input.secure !== false
    row.user = user.slice(0, 180)
    row.mailbox = mailbox.slice(0, 80)
    row.orders = input.orders === true
    row.alerts = input.alerts === true
    row.codes = input.codes === true
    if (!existing) boxes.push(row)
    this.syncLegacyImap()
    this.flush()
    return this.toMailboxView(row)
  }

  deleteMailbox(id: string): void {
    const boxes = this.mailboxes()
    const next = boxes.filter((row) => row.id !== id)
    if (next.length === boxes.length) throw new AppError("Mailbox not found.")
    this.data.mailboxes = next
    this.syncLegacyImap()
    this.flush()
  }

  saveOAuthMailbox(input: { user: string; provider: "gmail" | "outlook"; refreshToken: string; id?: string }): MailboxView {
    const user = input.user.trim()
    if (!user || !user.includes("@")) throw new AppError("Enter the email address before signing in.")
    if (!input.refreshToken || /[\r\n]/.test(input.refreshToken)) throw new AppError("The sign-in did not return a usable token.")
    const preset = input.provider === "gmail"
      ? { host: "imap.gmail.com", port: 993 }
      : { host: "outlook.office365.com", port: 993 }
    const boxes = this.mailboxes()
    const existing = (input.id ? boxes.find((row) => row.id === input.id) : undefined) ?? boxes.find((row) => row.user.toLowerCase() === user.toLowerCase() && row.provider === input.provider)
    if (!existing && boxes.length >= 8) throw new AppError("Save at most 8 mailboxes.")
    const row = existing ?? this.blankMailbox()
    row.name = user.slice(0, 80)
    row.enabled = true
    row.provider = input.provider
    row.host = preset.host
    row.port = preset.port
    row.secure = true
    row.user = user.slice(0, 180)
    row.mailbox = row.mailbox || "INBOX"
    row.auth = "xoauth2"
    row.passwordSecret = undefined
    row.refreshSecret = this.cipher.encrypt(input.refreshToken)
    row.orders = true
    row.codes = true
    row.lastError = ""
    if (!existing) boxes.push(row)
    this.syncLegacyImap()
    this.flush()
    return this.toMailboxView(row)
  }

  mailboxLogins(purpose: "orders" | "alerts" | "codes"): MailboxLogin[] {
    const logins: MailboxLogin[] = []
    for (const row of this.mailboxes()) {
      const login = this.loginFrom(row)
      if (!login || !row.enabled) continue
      if (purpose === "orders" && !row.orders) continue
      if (purpose === "alerts" && !row.alerts) continue
      if (purpose === "codes" && !row.codes) continue
      logins.push(login)
    }
    return logins
  }

  mailboxSecret(id: string): MailboxLogin | null {
    const row = this.mailboxes().find((item) => item.id === id)
    return row ? this.loginFrom(row) : null
  }

  noteMailbox(id: string, update: { ok: boolean; error?: string; folders?: string[] }): void {
    const row = this.mailboxes().find((item) => item.id === id)
    if (!row) return
    if (update.ok) {
      row.lastOkAt = Date.now()
      row.lastError = ""
    } else if (update.error) {
      row.lastError = redact(update.error).replace(/\s+/g, " ").trim().slice(0, 280)
    }
    if (update.folders) row.folders = update.folders.map((name) => name.slice(0, 80)).filter(Boolean).slice(0, 80)
    this.flush()
  }

  claimMailAlert(id: string, uid: string): boolean {
    const row = this.mailboxes().find((item) => item.id === id)
    const key = uid.trim().slice(0, 40)
    if (!row || !key) return false
    if (row.seenAlertIds.includes(key)) return false
    row.seenAlertIds = [key, ...row.seenAlertIds].slice(0, 200)
    this.flush()
    return true
  }

  private loginFrom(row: MailboxFile): MailboxLogin | null {
    const secret = row.auth === "xoauth2" ? row.refreshSecret : row.passwordSecret
    if (!secret || !row.host || !row.user) return null
    return {
      id: row.id,
      host: row.host,
      port: row.port,
      secure: row.secure !== false,
      user: row.user,
      password: this.cipher.decrypt(secret),
      mailbox: row.mailbox || "INBOX",
      provider: row.provider,
      auth: row.auth === "xoauth2" ? "xoauth2" : "password"
    }
  }

  private mailboxes(): MailboxFile[] {
    if (!this.data.mailboxes) this.data.mailboxes = []
    return this.data.mailboxes
  }

  private blankMailbox(): MailboxFile {
    return {
      id: randomUUID(),
      name: "Mailbox",
      enabled: false,
      provider: "custom",
      host: "",
      port: 993,
      secure: true,
      user: "",
      mailbox: "INBOX",
      auth: "password",
      orders: true,
      alerts: false,
      codes: true,
      lastOkAt: null,
      lastError: "",
      folders: [],
      seenAlertIds: []
    }
  }

  private applyPassword(row: MailboxFile, password: string, action: MailboxInput["passwordAction"]): void {
    if (action === "clear") row.passwordSecret = undefined
    if (action !== "replace") return
    if (!password) throw new AppError("Enter the app password.")
    if (/[\r\n]/.test(password)) throw new AppError("The app password cannot contain a line break.")
    row.passwordSecret = this.cipher.encrypt(password)
    row.refreshSecret = undefined
    row.auth = "password"
  }

  private toMailboxView(row: MailboxFile): MailboxView {
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      provider: row.provider,
      host: row.host,
      port: row.port,
      secure: row.secure !== false,
      user: row.user,
      mailbox: row.mailbox,
      hasPassword: Boolean(row.passwordSecret || row.refreshSecret),
      auth: row.auth === "xoauth2" ? "xoauth2" : "password",
      orders: row.orders,
      alerts: row.alerts,
      codes: row.codes,
      lastOkAt: row.lastOkAt,
      lastError: row.lastError,
      folders: [...row.folders]
    }
  }

  private syncLegacyImap(): void {
    const first = this.mailboxes()[0]
    this.data.imap = first
      ? {
          enabled: first.enabled,
          host: first.host,
          port: first.port,
          user: first.user,
          mailbox: first.mailbox,
          passwordSecret: first.passwordSecret
        }
      : { enabled: false, host: "", port: 993, user: "", mailbox: "INBOX" }
  }

  private restock(): RestockFile {
    if (!this.data.restock) this.data.restock = emptyRestock()
    return this.data.restock
  }

  private requireProfile(id: string): ProfileRecord {
    const profile = this.data.profiles.find((item) => item.id === id)
    if (!profile) throw new AppError("Profile not found.")
    return profile
  }

  private requireAccount(id: string): AccountRecord {
    const account = this.data.accounts.find((item) => item.id === id)
    if (!account) throw new AppError("Account not found.")
    return account
  }

  private requireTask(id: string): PublicTask {
    const task = this.data.tasks.find((item) => item.id === id)
    if (!task) throw new AppError("Task not found.")
    return task
  }

  private decryptCard(record: ProfileRecord): CardSecret {
    return JSON.parse(this.cipher.decrypt(record.cardSecret)) as CardSecret
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // Windows ignores POSIX modes.
    }
  }
}

function emptyDb(): DbFile {
  return {
    version: 1,
    pcId: randomUUID(),
    settings: { ...DEFAULT_SETTINGS },
    profiles: [],
    accounts: [],
    proxyGroups: [],
    tasks: [],
    devices: [],
    restock: emptyRestock(),
    hygiene: emptyHygiene(),
    schedules: [],
    checkouts: [],
    stockLog: [],
    monitorSamples: [],
    templates: [],
    orders: [],
    heals: {},
    learnedKeys: [],
    reportDay: "",
    imap: { enabled: false, host: "", port: 993, user: "", mailbox: "INBOX" },
    mailboxes: [],
    vault: [],
    clients: [meClient()],
    ledger: [],
    declines: [],
    updates: emptyUpdates()
  }
}

export interface MailboxLogin {
  id: string
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  mailbox: string
  provider: MailProvider
  auth: "password" | "xoauth2"
}

function loadMailboxes(value: DbFile["mailboxes"], legacy: DbFile["imap"]): MailboxFile[] {
  if (Array.isArray(value)) return value.map(normalizeMailbox).slice(0, 8)
  const imap = normalizeImap(legacy)
  if (!imap.host && !imap.user && !imap.passwordSecret) return []
  return [{
    id: randomUUID(),
    name: imap.user || "Mailbox",
    enabled: imap.enabled,
    provider: providerForHost(imap.host),
    host: imap.host,
    port: imap.port,
    secure: true,
    user: imap.user,
    mailbox: imap.mailbox,
    passwordSecret: imap.passwordSecret,
    auth: "password",
    orders: true,
    alerts: false,
    codes: true,
    lastOkAt: null,
    lastError: "",
    folders: [],
    seenAlertIds: []
  }]
}

function normalizeMailbox(value: Partial<MailboxFile> | undefined): MailboxFile {
  const host = typeof value?.host === "string" ? value.host : ""
  const provider = typeof value?.provider === "string" && isMailProvider(value.provider) ? value.provider : providerForHost(host)
  return {
    id: typeof value?.id === "string" && value.id ? value.id : randomUUID(),
    name: typeof value?.name === "string" && value.name ? value.name.slice(0, 80) : "Mailbox",
    enabled: value?.enabled === true,
    provider,
    host,
    port: typeof value?.port === "number" ? value.port : 993,
    secure: value?.secure !== false,
    user: typeof value?.user === "string" ? value.user : "",
    mailbox: typeof value?.mailbox === "string" && value.mailbox ? value.mailbox : "INBOX",
    passwordSecret: typeof value?.passwordSecret === "string" ? value.passwordSecret : undefined,
    refreshSecret: typeof value?.refreshSecret === "string" ? value.refreshSecret : undefined,
    auth: value?.auth === "xoauth2" ? "xoauth2" : "password",
    orders: value?.orders !== false,
    alerts: value?.alerts === true,
    codes: value?.codes !== false,
    lastOkAt: typeof value?.lastOkAt === "number" ? value.lastOkAt : null,
    lastError: typeof value?.lastError === "string" ? value.lastError.slice(0, 180) : "",
    folders: Array.isArray(value?.folders) ? value.folders.filter((item): item is string => typeof item === "string").slice(0, 80) : [],
    seenAlertIds: Array.isArray(value?.seenAlertIds) ? value.seenAlertIds.filter((item): item is string => typeof item === "string").slice(0, 200) : []
  }
}

function normalizeImap(value: DbFile["imap"]): NonNullable<DbFile["imap"]> {
  return {
    enabled: value?.enabled === true,
    host: typeof value?.host === "string" ? value.host : "",
    port: typeof value?.port === "number" ? value.port : 993,
    user: typeof value?.user === "string" ? value.user : "",
    mailbox: typeof value?.mailbox === "string" && value.mailbox ? value.mailbox : "INBOX",
    passwordSecret: typeof value?.passwordSecret === "string" ? value.passwordSecret : undefined
  }
}

function emptyRestock(): RestockFile {
  return { discordChannelId: "", discordChannelIds: [], discordCursors: {}, discordWatch: false, lastDiscordMessageId: "", alertAllowlist: "", alertDedupeMin: 30, alertSeen: [], rules: [], watches: [], log: [] }
}

function discordChannels(restock: RestockFile): string[] {
  return [...new Set([restock.discordChannelId, ...(restock.discordChannelIds ?? [])].map((id) => id.trim()).filter((id) => /^\d{17,22}$/.test(id)))]
}

function cardLast4(value: string | undefined): string | undefined {
  return value && /^\d{4}$/.test(value) ? value : undefined
}

function blankAddress(): Address {
  return { firstName: "", lastName: "", line1: "", line2: "", city: "", state: "", zip: "", country: "US" }
}

function addressOrBlank(value: Partial<Address> | undefined): Address {
  const blank = blankAddress()
  if (!value || typeof value !== "object") return blank
  return {
    firstName: typeof value.firstName === "string" ? value.firstName : "",
    lastName: typeof value.lastName === "string" ? value.lastName : "",
    line1: typeof value.line1 === "string" ? value.line1 : "",
    line2: typeof value.line2 === "string" ? value.line2 : "",
    city: typeof value.city === "string" ? value.city : "",
    state: typeof value.state === "string" ? value.state : "",
    zip: typeof value.zip === "string" ? value.zip : "",
    country: "US"
  }
}

function sealProfile(raw: {
  id?: string
  name?: string
  cardName?: string
  last4?: string
  expMonth?: string
  expYear?: string
  cardSecret?: string
  piiSecret?: string
  clientId?: string
  email?: string
  phone?: string
  shipping?: Address
  billing?: Address
}, cipher: Cipher): ProfileRecord {
  if (!raw || typeof raw.id !== "string" || !raw.id || typeof raw.cardSecret !== "string" || !raw.cardSecret) {
    throw new AppError("A profile in the data file is incomplete.")
  }
  const clientId = clientIdOf(raw.clientId)
  const base = {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "",
    cardName: typeof raw.cardName === "string" ? raw.cardName : "",
    last4: typeof raw.last4 === "string" ? raw.last4 : "",
    expMonth: typeof raw.expMonth === "string" ? raw.expMonth : "",
    expYear: typeof raw.expYear === "string" ? raw.expYear : "",
    cardSecret: raw.cardSecret,
    clientId
  }
  if (typeof raw.piiSecret === "string" && raw.piiSecret) return { ...base, piiSecret: raw.piiSecret }
  const pii: ProfilePii = {
    email: typeof raw.email === "string" ? raw.email : "",
    phone: typeof raw.phone === "string" ? raw.phone : "",
    shipping: addressOrBlank(raw.shipping),
    billing: addressOrBlank(raw.billing)
  }
  return { ...base, piiSecret: cipher.encrypt(JSON.stringify(pii)) }
}

function normalizeClients(value: Client[] | undefined): Client[] {
  const rows: Client[] = []
  const seen = new Set<string>()
  if (Array.isArray(value)) {
    for (const raw of value) {
      const client = cleanStoredClient(raw)
      if (!client || seen.has(client.id)) continue
      seen.add(client.id)
      rows.push(client)
    }
  }
  if (!seen.has(ME_CLIENT_ID)) rows.unshift(meClient(0))
  return rows.slice(0, 200)
}

function cleanStoredClient(raw: Partial<Client> | undefined): Client | null {
  if (!raw || typeof raw.id !== "string" || !raw.id.trim()) return null
  const id = raw.id === ME_CLIENT_ID ? ME_CLIENT_ID : /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id : ""
  if (!id) return null
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : id === ME_CLIENT_ID ? "Me" : ""
  if (!name) return null
  const fee = roundMoney(Number(raw.fee) || 0)
  return {
    id,
    name,
    contact: typeof raw.contact === "string" ? raw.contact.slice(0, 120) : "",
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, 1000) : "",
    feeBasis: raw.feeBasis === "item" ? "item" : "success",
    fee: fee < 0 || fee > 10000 ? 0 : fee,
    status: raw.status === "paused" ? "paused" : "active",
    webhook: typeof raw.webhook === "string" ? raw.webhook.slice(0, 400) : "",
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0
  }
}

function normalizeDeclines(value: CardDecline[] | undefined): CardDecline[] {
  if (!Array.isArray(value)) return []
  const rows: CardDecline[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue
    const store = typeof raw.store === "string" && (STORE_IDS as readonly string[]).includes(raw.store) ? raw.store as StoreId : null
    const last4 = typeof raw.last4 === "string" && /^\d{4}$/.test(raw.last4) ? raw.last4 : ""
    if (!store || !last4 || typeof raw.taskId !== "string" || !raw.taskId) continue
    rows.push({
      taskId: raw.taskId.slice(0, 80),
      last4,
      at: typeof raw.at === "number" ? raw.at : Date.now(),
      store,
      sku: typeof raw.sku === "string" ? raw.sku.slice(0, 180) : ""
    })
    if (rows.length >= 200) break
  }
  return rows
}

function normalizeLedger(value: LedgerEntry[] | undefined): LedgerEntry[] {
  if (!Array.isArray(value)) return []
  const rows: LedgerEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue
    const store = typeof raw.store === "string" && (STORE_IDS as readonly string[]).includes(raw.store) ? raw.store as StoreId : null
    if (!store || typeof raw.id !== "string" || !raw.id) continue
    const quantity = Math.round(Number(raw.quantity))
    const fee = roundMoney(Number(raw.fee))
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) continue
    if (!Number.isFinite(fee) || fee < 0 || fee > 100000) continue
    const price = raw.price === null || raw.price === undefined ? null : Number(raw.price)
    rows.push({
      id: raw.id,
      at: typeof raw.at === "number" ? raw.at : Date.now(),
      clientId: clientIdOf(raw.clientId),
      clientName: typeof raw.clientName === "string" ? raw.clientName.slice(0, 80) : "Me",
      store,
      sku: typeof raw.sku === "string" ? raw.sku.slice(0, 180) : "",
      product: typeof raw.product === "string" ? raw.product.slice(0, 180) : "",
      quantity,
      price: price !== null && Number.isFinite(price) ? roundMoney(price) : null,
      orderId: typeof raw.orderId === "string" ? raw.orderId.slice(0, 80) : "",
      fee,
      paid: raw.paid === true,
      paidAt: raw.paid === true && typeof raw.paidAt === "number" ? raw.paidAt : null
    })
    if (rows.length >= 2000) break
  }
  return rows
}

function toPublicAccount(record: AccountRecord): PublicAccount {
  const hasSession = Boolean(record.sessionSecret)
  return {
    id: record.id,
    store: record.store,
    label: record.label,
    username: record.username,
    hasPassword: Boolean(record.passwordSecret),
    hasSession,
    proxyGroupId: record.proxyGroupId ?? null,
    sessionState: hasSession ? record.sessionState === "expired" ? "expired" : "saved" : "missing",
    lastWarmAt: record.lastWarmAt ?? null,
    clientId: clientIdOf(record.clientId)
  }
}

function emptyHygiene(): HygieneFile {
  return { pins: [], scores: [], blocks: [] }
}

function normalizeHygiene(value: HygieneFile | undefined): HygieneFile {
  const base = emptyHygiene()
  if (!value) return base
  return {
    pins: Array.isArray(value.pins) ? value.pins : [],
    scores: Array.isArray(value.scores) ? value.scores : [],
    blocks: Array.isArray(value.blocks) ? value.blocks : []
  }
}

function cardSecretFrom(card: { number: string; cvv: string; expMonth: string; expYear: string; name: string }): CardSecret {
  return { number: card.number, cvv: card.cvv, expMonth: card.expMonth, expYear: card.expYear, name: card.name }
}

function cloneTask(task: PublicTask): PublicTask {
  const role = normalizeRole(task)
  return { ...task, ...role, group: task.group ?? "", testMode: task.testMode === true, monitorProxyGroupId: task.monitorProxyGroupId ?? null, rank: task.rank ?? 0, imageUrl: task.imageUrl ?? "", monitorOnly: role.kind === "monitor" || task.monitorOnly === true, monitorMs: task.monitorMs, detectToCartMs: task.detectToCartMs, overrides: task.overrides ? { ...task.overrides } : undefined, logs: task.logs.map((line) => ({ ...line })) }
}

function emptyLicense(): LicenseFile {
  return { publicKey: "", issued: [] }
}

function normalizeLicense(value: LicenseFile | undefined): LicenseFile | undefined {
  if (!value || typeof value !== "object") return undefined
  const issued = Array.isArray(value.issued) ? value.issued.filter((row) => row && typeof row.id === "string" && typeof row.tokenSecret === "string").map((row) => ({
    id: row.id,
    holder: typeof row.holder === "string" ? row.holder : "",
    seats: Number.isInteger(row.seats) ? row.seats : 1,
    expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : null,
    revoked: row.revoked === true,
    machines: Array.isArray(row.machines) ? row.machines.filter((id) => typeof id === "string") : [],
    tokenSecret: row.tokenSecret
  })) : []
  const activation = value.activation && typeof value.activation.tokenSecret === "string" && typeof value.activation.machineId === "string" ? value.activation : undefined
  return {
    publicKey: typeof value.publicKey === "string" ? value.publicKey : "",
    privateSecret: typeof value.privateSecret === "string" ? value.privateSecret : undefined,
    adminSecret: typeof value.adminSecret === "string" ? value.adminSecret : undefined,
    issued,
    activation
  }
}

function normalizeBackup(value: { tokenSecret?: string } | undefined): { tokenSecret?: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  return { tokenSecret: typeof value.tokenSecret === "string" ? value.tokenSecret : undefined }
}

function safeId(id: string | undefined): string {
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : randomUUID()
}

function cleanBackupProxy(group: ProxyGroup): ProxyGroup {
  if (!group || typeof group.name !== "string" || !group.name.trim()) throw new AppError("A proxy group in the backup is incomplete.")
  const proxies = (group.proxies ?? []).slice(0, 200).map((proxy) => {
    const port = Math.round(Number(proxy.port))
    if (!proxy.host || !Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("A proxy in the backup is incomplete.")
    return {
      id: safeId(proxy.id),
      host: String(proxy.host).slice(0, 200),
      port,
      username: proxy.username ? String(proxy.username).slice(0, 200) : undefined,
      password: proxy.password ? String(proxy.password).slice(0, 200) : undefined
    }
  })
  if (!proxies.length) throw new AppError("A proxy group in the backup has no proxies.")
  return {
    id: safeId(group.id),
    name: group.name.trim().slice(0, 80),
    network: group.network === "residential" ? "residential" : "datacenter",
    proxies
  }
}

function taskInputFromBackup(task: PublicTask): TaskInput {
  return {
    id: task.id,
    store: task.store,
    sku: task.sku,
    quantity: task.quantity,
    profileId: task.profileId,
    accountId: task.accountId,
    proxyGroupId: task.proxyGroupId,
    monitorProxyGroupId: task.monitorProxyGroupId,
    confirmPurchase: task.confirmPurchase,
    testMode: task.testMode,
    group: task.group,
    imageUrl: task.imageUrl,
    monitorOnly: task.monitorOnly,
    overrides: task.overrides,
    kind: task.kind,
    keywords: task.keywords,
    priceCap: task.priceCap,
    webhook: task.webhook,
    activeHours: task.activeHours,
    linkedCheckoutIds: task.linkedCheckoutIds,
    checkoutDelayMs: task.checkoutDelayMs,
    maxPrice: task.maxPrice,
    startMode: task.startMode,
    linkedMonitorId: task.linkedMonitorId,
    jitterPct: task.jitterPct,
    clientId: task.clientId
  }
}

function emptyUpdates(): UpdateFile {
  return { desktopVersion: null, phoneVersion: null, notes: "", checkedAt: 0 }
}

function normalizeUpdates(value: UpdateFile | undefined): UpdateFile {
  const base = emptyUpdates()
  if (!value) return base
  return {
    tokenSecret: typeof value.tokenSecret === "string" ? value.tokenSecret : undefined,
    desktopVersion: typeof value.desktopVersion === "string" ? value.desktopVersion : null,
    phoneVersion: typeof value.phoneVersion === "string" ? value.phoneVersion : null,
    notes: typeof value.notes === "string" ? value.notes : "",
    checkedAt: typeof value.checkedAt === "number" ? value.checkedAt : 0
  }
}

function normalizeCalendar(value: CalendarEvent[] | undefined): CalendarEvent[] {
  if (!Array.isArray(value)) return []
  return value.filter((event) => event && typeof event.id === "string" && (event.game === "pokemon" || event.game === "onepiece") && typeof event.startAt === "number" && STORE_IDS.includes(event.store)).map((event) => ({
    id: event.id,
    game: event.game,
    name: typeof event.name === "string" ? event.name : "Release",
    startAt: event.startAt,
    store: event.store,
    sku: typeof event.sku === "string" ? event.sku : "",
    note: typeof event.note === "string" ? event.note : ""
  })).slice(0, 200)
}

function normalizeSchedules(value: DropSchedule[] | undefined): DropSchedule[] {
  if (!Array.isArray(value)) return []
  return value.filter((schedule) => schedule && typeof schedule.id === "string" && typeof schedule.startAt === "number").map((schedule) => ({
    id: schedule.id,
    name: typeof schedule.name === "string" ? schedule.name : "Drop",
    enabled: schedule.enabled !== false,
    startAt: schedule.startAt,
    stopAt: typeof schedule.stopAt === "number" ? schedule.stopAt : null,
    warmupMin: typeof schedule.warmupMin === "number" ? schedule.warmupMin : 0,
    rehearsalMin: typeof schedule.rehearsalMin === "number" ? schedule.rehearsalMin : 0,
    rehearsalAt: typeof schedule.rehearsalAt === "number" ? schedule.rehearsalAt : null,
    taskIds: Array.isArray(schedule.taskIds) ? schedule.taskIds.filter((id) => typeof id === "string") : [],
    group: typeof schedule.group === "string" ? schedule.group : "",
    phase: schedule.phase === "warming" || schedule.phase === "started" || schedule.phase === "stopped" ? schedule.phase : "waiting"
  }))
}

function normalizeCheckouts(value: CheckoutRecord[] | undefined): CheckoutRecord[] {
  if (!Array.isArray(value)) return []
  const outcomes = new Set<CheckoutOutcome>(["success", "failure", "paused", "tested"])
  return value.filter((record) => record && typeof record.id === "string" && outcomes.has(record.outcome)).slice(0, 400).map((record) => {
    const marketValue = typeof record.marketValue === "number" && Number.isFinite(record.marketValue) && record.marketValue >= 0 ? Math.round(record.marketValue * 100) / 100 : null
    return { ...record, marketValue, last4: cardLast4(record.last4) }
  })
}

function normalizeRestock(value: RestockFile | undefined): RestockFile {
  const base = emptyRestock()
  if (!value) return base
  return {
    tokenSecret: typeof value.tokenSecret === "string" ? value.tokenSecret : undefined,
    discordBotSecret: typeof value.discordBotSecret === "string" ? value.discordBotSecret : undefined,
    discordChannelId: typeof value.discordChannelId === "string" ? value.discordChannelId : "",
    discordChannelIds: Array.isArray(value.discordChannelIds) ? value.discordChannelIds.filter((id) => typeof id === "string").slice(0, 20) : [],
    discordCursors: value.discordCursors && typeof value.discordCursors === "object" ? value.discordCursors : {},
    discordWatch: value.discordWatch === true,
    lastDiscordMessageId: typeof value.lastDiscordMessageId === "string" ? value.lastDiscordMessageId : "",
    alertAllowlist: typeof value.alertAllowlist === "string" ? value.alertAllowlist.slice(0, 2000) : "",
    alertDedupeMin: typeof value.alertDedupeMin === "number" ? value.alertDedupeMin : 30,
    alertSeen: Array.isArray(value.alertSeen) ? value.alertSeen.filter((item) => item && typeof item.key === "string" && typeof item.at === "number").slice(0, 200) : [],
    rules: Array.isArray(value.rules) ? value.rules : [],
    watches: Array.isArray(value.watches) ? value.watches : [],
    log: Array.isArray(value.log) ? value.log : []
  }
}

function cleanRule(input: RestockRuleInput, existing: RestockRule | undefined, db: Database): RestockRule {
  const name = input.name.trim()
  if (!name) throw new AppError("Rule name is required.")
  const store = input.store ? assertStore(input.store) : ""
  const sku = input.sku.trim()
  const keywords = input.keywords.trim()
  if (!sku && !parseKeywordQuery(keywords).positive.length && !keywords) {
    throw new AppError("Enter a SKU or keywords. A rule cannot match every product.")
  }
  if (keywords && !parseKeywordQuery(keywords).positive.length && !sku) {
    throw new AppError("Keywords need at least one term to include. Prefix a term with - to exclude it.")
  }
  const quantity = cleanQty(input.quantity, "Quantity")
  const maxQuantity = cleanQty(input.maxQuantity, "Max quantity")
  if (quantity > maxQuantity) throw new AppError("Quantity cannot be above the max quantity.")
  const taskId = input.taskId || null
  if (taskId) {
    const task = db.getTask(taskId)
    if (store && task.store !== store) throw new AppError("The template task is for a different store.")
  } else {
    if (!input.profileId) throw new AppError("Choose a profile, or pick a template task.")
    db.readProfile(input.profileId)
    const account = db.readAccount(input.accountId)
    if (store && account.store !== store) throw new AppError("Choose an account for the same store as the rule.")
  }
  if (input.proxyGroupId) db.getProxyGroup(input.proxyGroupId)
  return {
    id: existing?.id ?? randomUUID(),
    name: name.slice(0, 80),
    enabled: input.enabled === true,
    store,
    sku: sku.slice(0, 200),
    keywords: keywords.slice(0, 240),
    taskId,
    profileId: taskId ? "" : input.profileId,
    accountId: taskId ? "" : input.accountId,
    proxyGroupId: input.proxyGroupId || null,
    quantity,
    maxQuantity,
    maxPrice: cleanMaxPrice(input.maxPrice),
    cooldownSec: cleanCooldown(input.cooldownSec),
    testMode: input.testMode === true,
    confirmPurchase: input.confirmPurchase === true,
    lastFiredAt: existing?.lastFiredAt ?? 0
  }
}

function cleanWatch(input: KeywordWatchInput, existing: KeywordWatch | undefined, db: Database): KeywordWatch {
  const name = input.name.trim()
  if (!name) throw new AppError("Watch name is required.")
  const store = assertStore(input.store)
  const keywords = input.keywords.trim()
  if (!parseKeywordQuery(keywords).positive.length) throw new AppError("Keywords need at least one term to include. Prefix a term with - to exclude it.")
  const quantity = cleanQty(input.quantity, "Quantity")
  const maxQuantity = cleanQty(input.maxQuantity, "Max quantity")
  if (quantity > maxQuantity) throw new AppError("Quantity cannot be above the max quantity.")
  db.readProfile(input.profileId)
  const account = db.readAccount(input.accountId)
  if (account.store !== store) throw new AppError("Choose an account for the same store as the watch.")
  if (input.proxyGroupId) db.getProxyGroup(input.proxyGroupId)
  const enabled = input.enabled === true
  return {
    id: existing?.id ?? randomUUID(),
    name: name.slice(0, 80),
    enabled,
    store,
    keywords: keywords.slice(0, 240),
    maxPrice: cleanMaxPrice(input.maxPrice),
    soldByRetailer: input.soldByRetailer !== false,
    proxyGroupId: input.proxyGroupId || null,
    profileId: input.profileId,
    accountId: input.accountId,
    quantity,
    maxQuantity,
    autoStart: input.autoStart === true,
    testMode: input.testMode === true,
    confirmPurchase: input.confirmPurchase === true,
    seenSkus: input.resetSeen ? [] : existing?.seenSkus ?? [],
    status: enabled ? existing?.status === "blocked" ? "blocked" : existing?.status === "watching" ? "watching" : "idle" : "paused",
    detail: existing?.detail ?? ""
  }
}

function cleanQty(value: number, label: string): number {
  const quantity = Math.round(Number(value))
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) throw new AppError(`${label} must be from 1 to 12.`)
  return quantity
}

function cleanCooldown(value: number): number {
  const seconds = Math.round(Number(value))
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) throw new AppError("Cooldown must be from 0 to 86400 seconds.")
  return seconds
}

function cleanMaxPrice(value: number | null): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value === "")) return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 100000) throw new AppError("Max price must be blank or a dollar amount.")
  return Math.round(number * 100) / 100
}

function cloneRule(rule: RestockRule): RestockRule {
  return { ...rule }
}

function cloneWatch(watch: KeywordWatch): KeywordWatch {
  return { ...watch, seenSkus: watch.seenSkus.slice() }
}

export function addressesEqual(a: Address, b: Address): boolean {
  return a.line1 === b.line1 && a.line2 === b.line2 && a.city === b.city && a.state === b.state && a.zip === b.zip && a.firstName === b.firstName && a.lastName === b.lastName
}
