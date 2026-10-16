import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Cipher } from "./cipher"
import { parseSession } from "./session"
import { parseKeywordQuery } from "./keywords"
import { assertStore, cleanAddress, cleanCard, cleanEmail, cleanPhone, cleanSettings } from "./validate"
import { AppError } from "../shared/errors"
import { parseProxyList } from "../shared/proxy"
import { isActiveStatus } from "../shared/types"
import type {
  AccountInput,
  Address,
  CardSecret,
  FullAccount,
  FullProfile,
  ProfileInput,
  ProxyGroup,
  ProxyGroupInput,
  PublicAccount,
  PublicProfile,
  AlertLog,
  DiscordWatchInput,
  KeywordWatch,
  KeywordWatchInput,
  PublicTask,
  RestockRule,
  RestockRuleInput,
  SecurityInfo,
  SessionCookies,
  Settings,
  TaskInput
} from "../shared/types"
import { DEFAULT_SETTINGS } from "../shared/types"

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
}

export class Database {
  private data: DbFile = emptyDb()

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
      restock: normalizeRestock(parsed.restock)
    }
    let changed = pcId !== parsed.pcId || !Array.isArray(parsed.devices)
    for (const task of this.data.tasks) {
      if (isActiveStatus(task.status)) {
        task.status = "paused"
        task.detail = "App closed while this task was running. Resume to continue."
        task.logs.push({ ts: Date.now(), level: "warn", message: task.detail })
        changed = true
      }
    }
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
    if (!existing && !passwordSecret && !sessionSecret) {
      throw new AppError("Save a password or a browser session for this account.")
    }
    const record: AccountRecord = {
      id: existing?.id ?? randomUUID(),
      store,
      label,
      username,
      passwordSecret,
      sessionSecret
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
      session: record.sessionSecret ? (JSON.parse(this.cipher.decrypt(record.sessionSecret)) as SessionCookies) : undefined
    }
  }

  updateSession(id: string, session: SessionCookies): void {
    const record = this.requireAccount(id)
    record.sessionSecret = this.cipher.encrypt(JSON.stringify(session))
    this.flush()
  }

  listProxyGroups(): ProxyGroup[] {
    return this.data.proxyGroups.map((group) => ({ ...group, proxies: group.proxies.map((proxy) => ({ ...proxy })) }))
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
    const group: ProxyGroup = {
      id: existing?.id ?? randomUUID(),
      name,
      proxies: parsed.proxies.map((proxy) => ({ ...proxy, id: randomUUID() }))
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
    return group
  }

  listTasks(): PublicTask[] {
    return this.data.tasks.map(cloneTask)
  }

  saveTask(input: TaskInput): PublicTask {
    const existing = input.id ? this.requireTask(input.id) : undefined
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
    const task: PublicTask = {
      id: existing?.id ?? randomUUID(),
      store,
      sku,
      quantity,
      profileId: input.profileId,
      accountId: input.accountId,
      proxyGroupId: input.proxyGroupId || null,
      confirmPurchase: Boolean(input.confirmPurchase),
      testMode: input.testMode === true,
      status: existing?.status === "paused" ? "paused" : "idle",
      detail: existing?.detail ?? "",
      logs: existing?.logs ?? [],
      createdAt: existing?.createdAt ?? Date.now(),
      startedAt: existing?.startedAt,
      finishedAt: existing?.finishedAt
    }
    if (existing) this.data.tasks = this.data.tasks.map((item) => (item.id === task.id ? task : item))
    else this.data.tasks.unshift(task)
    this.flush()
    return cloneTask(task)
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

  patchTask(id: string, patch: Partial<Pick<PublicTask, "status" | "detail" | "startedAt" | "finishedAt">> & { log?: PublicTask["logs"][number]; resetLogs?: boolean }): PublicTask {
    const task = this.requireTask(id)
    if (patch.resetLogs) task.logs = []
    if (patch.status) task.status = patch.status
    if (patch.detail !== undefined) task.detail = patch.detail
    if ("startedAt" in patch) task.startedAt = patch.startedAt
    if ("finishedAt" in patch) task.finishedAt = patch.finishedAt
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
    restock: emptyRestock()
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
  return {
    id: record.id,
    store: record.store,
    label: record.label,
    username: record.username,
    hasPassword: Boolean(record.passwordSecret),
    hasSession: Boolean(record.sessionSecret)
  }
}

function cardSecretFrom(card: { number: string; cvv: string; expMonth: string; expYear: string; name: string }): CardSecret {
  return { number: card.number, cvv: card.cvv, expMonth: card.expMonth, expYear: card.expYear, name: card.name }
}

function cloneTask(task: PublicTask): PublicTask {
  return { ...task, testMode: task.testMode === true, logs: task.logs.map((line) => ({ ...line })) }
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
