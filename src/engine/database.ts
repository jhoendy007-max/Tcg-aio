import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Cipher } from "./cipher"
import { parseSession } from "./session"
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
  PublicTask,
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

interface DbFile {
  version: 1
  settings: Settings
  profiles: ProfileRecord[]
  accounts: AccountRecord[]
  proxyGroups: ProxyGroup[]
  tasks: PublicTask[]
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
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as DbFile
    if (parsed.version !== 1) throw new AppError("This data file was written by a newer TCGAIO version.")
    this.data = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
      profiles: parsed.profiles ?? [],
      accounts: parsed.accounts ?? [],
      proxyGroups: parsed.proxyGroups ?? [],
      tasks: parsed.tasks ?? []
    }
    let changed = false
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
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, profiles: [], accounts: [], proxyGroups: [], tasks: [] }
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
  return { ...task, logs: task.logs.map((line) => ({ ...line })) }
}

export function addressesEqual(a: Address, b: Address): boolean {
  return a.line1 === b.line1 && a.line2 === b.line2 && a.city === b.city && a.state === b.state && a.zip === b.zip && a.firstName === b.firstName && a.lastName === b.lastName
}
