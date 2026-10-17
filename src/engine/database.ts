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
import { blockRate as tallyRate, chooseSticky, noteBlock, noteScore, type BlockTally, type StickyPin } from "./proxy-hygiene"
import { checkoutCsv, priceFromDetail, summarize } from "./analytics"
import { suggestWarmups, summarizeMonitor, type MonitorSample, type RestockEvent } from "./monitor"
import { vaultFlag } from "./vault"
import { parseAstLocal } from "./time"
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

interface ProfileRecord extends PublicProfile {
  cardSecret: string
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
  discordWatch: boolean
  lastDiscordMessageId: string
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
  updates?: UpdateFile
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
      profiles: parsed.profiles ?? [],
      accounts: parsed.accounts ?? [],
      proxyGroups: parsed.proxyGroups ?? [],
      tasks: parsed.tasks ?? [],
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      restock: normalizeRestock(parsed.restock),
      hygiene: normalizeHygiene(parsed.hygiene),
      schedules: normalizeSchedules(parsed.schedules),
      checkouts: normalizeCheckouts(parsed.checkouts),
      updates: normalizeUpdates(parsed.updates),
      stockLog: Array.isArray(parsed.stockLog) ? parsed.stockLog.slice(0, 400) : [],
      monitorSamples: Array.isArray(parsed.monitorSamples) ? parsed.monitorSamples.slice(0, 500) : [],
      templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders.slice(0, 200) : [],
      heals: parsed.heals && typeof parsed.heals === "object" ? parsed.heals : {},
      learnedKeys: Array.isArray(parsed.learnedKeys) ? parsed.learnedKeys.slice(0, 200) : [],
      reportDay: typeof parsed.reportDay === "string" ? parsed.reportDay : "",
      imap: normalizeImap(parsed.imap),
      mailboxes: loadMailboxes(parsed.mailboxes, parsed.imap),
      vault: Array.isArray(parsed.vault) ? parsed.vault : []
    }
    const migratedMail = !Array.isArray(parsed.mailboxes) && (this.data.mailboxes?.length ?? 0) > 0
    let changed = pcId !== parsed.pcId || !Array.isArray(parsed.devices) || migratedMail
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

  listProfiles(): PublicProfile[] {
    return this.data.profiles.map(toPublicProfile)
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
    const record: ProfileRecord = {
      id: existing?.id ?? randomUUID(),
      name,
      email,
      phone,
      shipping,
      billing,
      cardName,
      last4,
      expMonth,
      expYear,
      cardSecret
    }
    if (existing) this.data.profiles = this.data.profiles.map((profile) => (profile.id === record.id ? record : profile))
    else this.data.profiles.push(record)
    this.flush()
    return toPublicProfile(record)
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
    return { ...toPublicProfile(record), card: this.decryptCard(record) }
  }

  listAccounts(): PublicAccount[] {
    return this.data.accounts.map(toPublicAccount)
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
    const record: AccountRecord = {
      id: existing?.id ?? randomUUID(),
      store,
      label,
      username,
      passwordSecret,
      sessionSecret,
      proxyGroupId,
      sessionState: sessionSecret ? existing?.sessionState === "expired" && input.sessionAction !== "replace" ? "expired" : "saved" : "missing",
      lastWarmAt: sessionSecret ? existing?.lastWarmAt ?? null : null
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

  assignProxy(accountId: string, groupId: string, proxies: ProxyEndpoint[], now = Date.now()) {
    const hygiene = this.hygiene()
    const result = chooseSticky(proxies, hygiene.pins, hygiene.scores, accountId, groupId, now)
    hygiene.pins = result.pins
    this.flush()
    return result.choice
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
    const task = this.taskFrom(input, existing)
    if (existing) this.data.tasks = this.data.tasks.map((item) => (item.id === task.id ? task : item))
    else this.data.tasks.unshift(task)
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
      if (isActiveStatus(task.status)) {
        errors.push({ id, error: "Stop the task before editing it." })
        continue
      }
      if (account && account.store !== task.store) {
        errors.push({ id, error: "Choose an account for the same store as the task." })
        continue
      }
      if (quantity !== undefined) task.quantity = quantity
      if (input.profileId) task.profileId = input.profileId
      if (account) task.accountId = account.id
      if (input.proxyGroupId !== undefined) task.proxyGroupId = input.proxyGroupId || null
      if (input.confirmPurchase !== undefined) task.confirmPurchase = input.confirmPurchase
      if (input.testMode !== undefined) task.testMode = input.testMode
      if (input.group !== undefined) task.group = input.group.trim().slice(0, 40)
      updated.push(id)
    }
    if (updated.length) this.flush()
    return { updated, errors }
  }

  private taskFrom(input: TaskInput, existing: PublicTask | undefined): PublicTask {
    if (existing && isActiveStatus(existing.status)) throw new AppError("Stop the task before editing it.")
    const store = assertStore(input.store)
    const sku = input.sku.trim()
    if (!sku) throw new AppError("Product SKU or URL is required.")
    const quantity = Math.round(Number(input.quantity))
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) throw new AppError("Quantity must be from 1 to 12.")
    this.requireProfile(input.profileId)
    const account = this.requireAccount(input.accountId)
    if (account.store !== store) throw new AppError("Choose an account for the same store as the task.")
    if (input.proxyGroupId) this.getProxyGroup(input.proxyGroupId)
    if (input.monitorProxyGroupId) this.getProxyGroup(input.monitorProxyGroupId)
    const ranks = this.data.tasks.map((task) => task.rank ?? 0)
    return {
      id: existing?.id ?? randomUUID(),
      store,
      sku,
      quantity,
      profileId: input.profileId,
      accountId: input.accountId,
      proxyGroupId: input.proxyGroupId || null,
      monitorProxyGroupId: input.monitorProxyGroupId === undefined ? existing?.monitorProxyGroupId ?? null : input.monitorProxyGroupId || null,
      confirmPurchase: Boolean(input.confirmPurchase),
      testMode: input.testMode === true,
      group: (input.group ?? existing?.group ?? "").trim().slice(0, 40),
      rank: existing?.rank ?? (ranks.length ? Math.min(...ranks) - 1 : 0),
      imageUrl: input.imageUrl === undefined ? existing?.imageUrl ?? "" : cleanImageUrl(input.imageUrl),
      monitorOnly: input.monitorOnly === undefined ? existing?.monitorOnly === true : input.monitorOnly === true,
      status: existing?.status === "paused" ? "paused" : "idle",
      detail: existing?.detail ?? "",
      logs: existing?.logs ?? [],
      createdAt: existing?.createdAt ?? Date.now(),
      startedAt: existing?.startedAt,
      finishedAt: existing?.finishedAt
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
      detail
    }
    if (!this.data.checkouts) this.data.checkouts = []
    this.data.checkouts.unshift(record)
    this.data.checkouts = this.data.checkouts.slice(0, 400)
    this.flush()
    return { ...record }
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

  discordWatchConfig(): { enabled: boolean; channelId: string; token: string; lastMessageId: string; hasBot: boolean } {
    const restock = this.restock()
    return {
      enabled: restock.discordWatch,
      channelId: restock.discordChannelId,
      token: restock.discordBotSecret ? this.cipher.decrypt(restock.discordBotSecret) : "",
      lastMessageId: restock.lastDiscordMessageId,
      hasBot: Boolean(restock.discordBotSecret)
    }
  }

  saveDiscordWatch(input: DiscordWatchInput): void {
    const channelId = input.channelId.trim()
    if (channelId && !/^\d{17,22}$/.test(channelId)) throw new AppError("Discord channel ID must be the numeric channel id.")
    if (input.enabled && !channelId) throw new AppError("Enter the Discord channel ID before turning the watcher on.")
    const restock = this.restock()
    if (channelId !== restock.discordChannelId) restock.lastDiscordMessageId = ""
    if (input.tokenAction === "clear") restock.discordBotSecret = undefined
    if (input.tokenAction === "replace") {
      const token = input.token.trim()
      if (!token || token.length < 20) throw new AppError("Paste the Discord bot token.")
      restock.discordBotSecret = this.cipher.encrypt(token)
    }
    if (input.enabled && !restock.discordBotSecret) throw new AppError("Save a Discord bot token before turning the watcher on.")
    restock.discordChannelId = channelId
    restock.discordWatch = input.enabled === true
    if (!restock.discordWatch) restock.lastDiscordMessageId = ""
    this.flush()
  }

  setDiscordEnabled(enabled: boolean): void {
    this.restock().discordWatch = enabled
    this.flush()
  }

  setDiscordCursor(id: string): void {
    this.restock().lastDiscordMessageId = id
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

  noteOrder(id: string, status: OrderStatus, tracking: string, detail: string): void {
    const order = this.data.orders?.find((item) => item.id === id)
    if (!order) return
    order.status = status
    order.tracking = tracking.slice(0, 40)
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
    if (input.enabled && !row.passwordSecret) throw new AppError("Save the app password before turning this mailbox on.")
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

  mailboxLogins(purpose: "orders" | "alerts" | "codes"): MailboxLogin[] {
    const logins: MailboxLogin[] = []
    for (const row of this.mailboxes()) {
      if (!row.enabled || !row.passwordSecret || !row.host || !row.user) continue
      if (purpose === "orders" && !row.orders) continue
      if (purpose === "alerts" && !row.alerts) continue
      if (purpose === "codes" && !row.codes) continue
      logins.push({
        id: row.id,
        host: row.host,
        port: row.port,
        secure: row.secure !== false,
        user: row.user,
        password: this.cipher.decrypt(row.passwordSecret),
        mailbox: row.mailbox || "INBOX"
      })
    }
    return logins
  }

  mailboxSecret(id: string): MailboxLogin | null {
    const row = this.mailboxes().find((item) => item.id === id)
    if (!row?.passwordSecret || !row.host || !row.user) return null
    return {
      id: row.id,
      host: row.host,
      port: row.port,
      secure: row.secure !== false,
      user: row.user,
      password: this.cipher.decrypt(row.passwordSecret),
      mailbox: row.mailbox || "INBOX"
    }
  }

  noteMailbox(id: string, update: { ok: boolean; error?: string; folders?: string[] }): void {
    const row = this.mailboxes().find((item) => item.id === id)
    if (!row) return
    if (update.ok) {
      row.lastOkAt = Date.now()
      row.lastError = ""
    } else if (update.error) {
      row.lastError = redact(update.error).replace(/\s+/g, " ").trim().slice(0, 180)
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
      hasPassword: Boolean(row.passwordSecret),
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
  return { discordChannelId: "", discordWatch: false, lastDiscordMessageId: "", rules: [], watches: [], log: [] }
}

function toPublicProfile(record: ProfileRecord): PublicProfile {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    phone: record.phone,
    shipping: record.shipping,
    billing: record.billing,
    cardName: record.cardName,
    last4: record.last4,
    expMonth: record.expMonth,
    expYear: record.expYear
  }
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
    lastWarmAt: record.lastWarmAt ?? null
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
  return { ...task, group: task.group ?? "", testMode: task.testMode === true, monitorProxyGroupId: task.monitorProxyGroupId ?? null, rank: task.rank ?? 0, imageUrl: task.imageUrl ?? "", monitorOnly: task.monitorOnly === true, monitorMs: task.monitorMs, detectToCartMs: task.detectToCartMs, logs: task.logs.map((line) => ({ ...line })) }
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

function normalizeSchedules(value: DropSchedule[] | undefined): DropSchedule[] {
  if (!Array.isArray(value)) return []
  return value.filter((schedule) => schedule && typeof schedule.id === "string" && typeof schedule.startAt === "number").map((schedule) => ({
    id: schedule.id,
    name: typeof schedule.name === "string" ? schedule.name : "Drop",
    enabled: schedule.enabled !== false,
    startAt: schedule.startAt,
    stopAt: typeof schedule.stopAt === "number" ? schedule.stopAt : null,
    warmupMin: typeof schedule.warmupMin === "number" ? schedule.warmupMin : 0,
    taskIds: Array.isArray(schedule.taskIds) ? schedule.taskIds.filter((id) => typeof id === "string") : [],
    group: typeof schedule.group === "string" ? schedule.group : "",
    phase: schedule.phase === "warming" || schedule.phase === "started" || schedule.phase === "stopped" ? schedule.phase : "waiting"
  }))
}

function normalizeCheckouts(value: CheckoutRecord[] | undefined): CheckoutRecord[] {
  if (!Array.isArray(value)) return []
  const outcomes = new Set<CheckoutOutcome>(["success", "failure", "paused", "tested"])
  return value.filter((record) => record && typeof record.id === "string" && outcomes.has(record.outcome)).slice(0, 400)
}

function normalizeRestock(value: RestockFile | undefined): RestockFile {
  const base = emptyRestock()
  if (!value) return base
  return {
    tokenSecret: typeof value.tokenSecret === "string" ? value.tokenSecret : undefined,
    discordBotSecret: typeof value.discordBotSecret === "string" ? value.discordBotSecret : undefined,
    discordChannelId: typeof value.discordChannelId === "string" ? value.discordChannelId : "",
    discordWatch: value.discordWatch === true,
    lastDiscordMessageId: typeof value.lastDiscordMessageId === "string" ? value.lastDiscordMessageId : "",
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
