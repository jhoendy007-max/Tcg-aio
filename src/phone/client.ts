import {
  encodePairingPayload,
  openFrame,
  pairKey,
  parseFrame,
  parsePairingPayload,
  seal,
  sessionKey,
  type ClientMessage,
  type PairingPayload,
  type PhoneAlerts,
  type PhoneChallenge,
  type PhoneNotice,
  type PhoneSnapshot,
  type PhoneTask,
  type PhoneTaskDraft,
  type ServerMessage
} from "./protocol"
import type { KeywordWatchInput, RestockRuleInput, StoreHealth, StoreId } from "../shared/types"

export interface SavedPhoneLink {
  token: string
  deviceId: string
  pcId: string
  pcName: string
  host: string
  port: number
  relay?: string
}

export interface PhoneCommandResult {
  ok: boolean
  error?: string
  started?: string[]
  errors?: { id: string; error: string }[]
  task?: PhoneTask
  health?: StoreHealth[]
  alerts?: PhoneAlerts
  csv?: string
  created?: number
  cookie?: string
}

export class PhoneRevoked extends Error {
  constructor() {
    super("This phone was revoked on the PC. Pair it again.")
    this.name = "PhoneRevoked"
  }
}

interface ConnectOptions {
  routes?: ("direct" | "relay")[]
  directTimeoutMs?: number
}

type Waiter = {
  match: (message: ServerMessage) => boolean
  resolve: (message: ServerMessage) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Phone-side session. Frames are AES-256-GCM. The one-time QR secret
 * wraps pairing, then the device token wraps every later frame.
 */
export class PhoneSession {
  conn = ""
  online = false
  private socket: WebSocket | null = null
  private key: Uint8Array | null = null
  private mode: "pair" | "session" = "pair"
  private pcId = ""
  private relayId = ""
  private relay = false
  private seen = new Set<string>()
  private inbox: ServerMessage[] = []
  private rawInbox: string[] = []
  private waiters: Waiter[] = []
  private onSnapshotCb: ((snapshot: PhoneSnapshot) => void) | null = null
  private onTaskCb: ((task: PhoneTask) => void) | null = null
  private onDeletedCb: ((id: string) => void) | null = null
  private onNoticeCb: ((notice: PhoneNotice) => void) | null = null
  private onAlertsCb: ((alerts: PhoneAlerts) => void) | null = null
  private onChallengeCb: ((challenge: PhoneChallenge | null) => void) | null = null
  private onOnlineCb: ((online: boolean) => void) | null = null
  private onVaultCb: ((accountId: string, cookie: string) => void) | null = null
  constructor(private link: SavedPhoneLink | null = null) {}

  saved(): SavedPhoneLink | null {
    return this.link
  }

  onSnapshot(cb: (snapshot: PhoneSnapshot) => void): void {
    this.onSnapshotCb = cb
  }

  onTask(cb: (task: PhoneTask) => void): void {
    this.onTaskCb = cb
  }

  onDeleted(cb: (id: string) => void): void {
    this.onDeletedCb = cb
  }

  onNotice(cb: (notice: PhoneNotice) => void): void {
    this.onNoticeCb = cb
  }

  onAlerts(cb: (alerts: PhoneAlerts) => void): void {
    this.onAlertsCb = cb
  }

  onChallenge(cb: (challenge: PhoneChallenge | null) => void): void {
    this.onChallengeCb = cb
  }

  onOnline(cb: (online: boolean) => void): void {
    this.onOnlineCb = cb
  }

  onVault(cb: (accountId: string, cookie: string) => void): void {
    this.onVaultCb = cb
  }

  linkVault(accountId: string, twoWay: boolean): Promise<PhoneCommandResult> {
    return this.request({ type: "vault.link", req: rid(), conn: this.conn, accountId, twoWay })
  }

  unlinkVault(accountId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "vault.unlink", req: rid(), conn: this.conn, accountId })
  }

  pushVault(accountId: string, cookie: string, expiresAt: number | null): Promise<PhoneCommandResult> {
    return this.request({ type: "vault.push", req: rid(), conn: this.conn, accountId, cookie, expiresAt })
  }

  pullVault(accountId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "vault.pull", req: rid(), conn: this.conn, accountId })
  }

  async pair(payload: PairingPayload, deviceName: string, options?: ConnectOptions): Promise<SavedPhoneLink> {
    await this.openTransport(payload, options)
    this.mode = "pair"
    this.key = pairKey(payload.secret)
    this.pcId = payload.pcId
    const pairedPromise = this.waitFor((message) => message.type === "paired")
    this.send({ type: "pair", deviceName })
    const paired = await pairedPromise
    if (paired.type !== "paired") throw new Error("Pairing did not finish.")
    const link: SavedPhoneLink = {
      token: paired.token,
      deviceId: paired.deviceId,
      pcId: payload.pcId,
      pcName: paired.pcName,
      host: payload.host,
      port: payload.port,
      relay: payload.relay
    }
    this.link = link
    this.mode = "session"
    this.key = sessionKey(link.token)
    const snapPromise = this.waitFor((message) => message.type === "snapshot")
    this.send({ type: "hello" })
    const snap = await snapPromise
    if (snap.type === "snapshot") {
      this.conn = snap.conn
      this.onSnapshotCb?.(snap.snapshot)
    }
    return link
  }

  async connect(options?: ConnectOptions): Promise<PhoneSnapshot> {
    if (!this.link) throw new Error("Pair this phone from the QR code on the PC.")
    const payload: PairingPayload = {
      v: 1,
      pcId: this.link.pcId,
      name: this.link.pcName,
      host: this.link.host,
      port: this.link.port,
      secret: this.link.token,
      relay: this.link.relay
    }
    await this.openTransport(payload, options)
    this.mode = "session"
    this.key = sessionKey(this.link.token)
    this.pcId = this.link.pcId
    const snapPromise = this.waitFor((message) => message.type === "snapshot" || message.type === "error")
    this.send({ type: "hello" })
    const snap = await snapPromise
    if (snap.type === "error") throw new Error(snap.error)
    if (snap.type !== "snapshot") throw new Error("The PC did not send tasks.")
    this.conn = snap.conn
    this.onSnapshotCb?.(snap.snapshot)
    return snap.snapshot
  }

  close(): void {
    this.socket?.close()
    this.socket = null
    this.setOnline(false)
  }

  async sync(): Promise<PhoneSnapshot> {
    const result = await this.request({ type: "sync", req: rid(), conn: this.conn })
    if (!result.ok) throw new Error(result.error || "Could not refresh.")
    const snap = await this.waitFor((message) => message.type === "snapshot")
    if (snap.type !== "snapshot") throw new Error("The PC did not send tasks.")
    return snap.snapshot
  }

  start(taskId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "task.start", req: rid(), conn: this.conn, taskId })
  }

  runTest(taskId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "task.test", req: rid(), conn: this.conn, taskId })
  }

  async checkHealth(proxyGroupId: string | null): Promise<PhoneCommandResult> {
    return this.request({ type: "health.check", req: rid(), conn: this.conn, proxyGroupId })
  }

  stop(taskId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "task.stop", req: rid(), conn: this.conn, taskId })
  }

  startAll(): Promise<PhoneCommandResult> {
    return this.request({ type: "task.startAll", req: rid(), conn: this.conn })
  }

  stopAll(): Promise<PhoneCommandResult> {
    return this.request({ type: "task.stopAll", req: rid(), conn: this.conn })
  }

  pauseAll(): Promise<PhoneCommandResult> {
    return this.request({ type: "task.pauseAll", req: rid(), conn: this.conn })
  }

  setAutopilot(enabled: boolean): Promise<PhoneCommandResult> {
    return this.request({ type: "autopilot.set", req: rid(), conn: this.conn, enabled })
  }

  setLanguage(language: "en" | "es"): Promise<PhoneCommandResult> {
    return this.request({ type: "language.set", req: rid(), conn: this.conn, language })
  }

  saveMailbox(mailbox: import("./protocol").PhoneMailDraft): Promise<PhoneCommandResult> {
    return this.request({ type: "mail.save", req: rid(), conn: this.conn, mailbox })
  }

  deleteMailbox(id: string): Promise<PhoneCommandResult> {
    return this.request({ type: "mail.delete", req: rid(), conn: this.conn, id })
  }

  signInMail(provider: "gmail" | "outlook", user: string): Promise<PhoneCommandResult> {
    return this.request({ type: "mail.oauth", req: rid(), conn: this.conn, provider, user })
  }

  saveModule(store: import("../shared/types").StoreId, record: import("../shared/types").ModuleRecord): Promise<PhoneCommandResult> {
    return this.request({ type: "module.save", req: rid(), conn: this.conn, store, record })
  }

  resetModule(store: import("../shared/types").StoreId): Promise<PhoneCommandResult> {
    return this.request({ type: "module.reset", req: rid(), conn: this.conn, store })
  }

  importModule(text: string): Promise<PhoneCommandResult> {
    return this.request({ type: "module.import", req: rid(), conn: this.conn, text })
  }

  saveTask(task: PhoneTaskDraft): Promise<PhoneCommandResult> {
    return this.request({ type: "task.save", req: rid(), conn: this.conn, task })
  }

  deleteTask(taskId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "task.delete", req: rid(), conn: this.conn, taskId })
  }

  saveRule(rule: RestockRuleInput): Promise<PhoneCommandResult> {
    return this.request({ type: "rule.save", req: rid(), conn: this.conn, rule })
  }

  deleteRule(ruleId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "rule.delete", req: rid(), conn: this.conn, ruleId })
  }

  toggleRule(ruleId: string, enabled: boolean): Promise<PhoneCommandResult> {
    return this.request({ type: "rule.toggle", req: rid(), conn: this.conn, ruleId, enabled })
  }

  saveWatch(watch: KeywordWatchInput): Promise<PhoneCommandResult> {
    return this.request({ type: "watch.save", req: rid(), conn: this.conn, watch })
  }

  deleteWatch(watchId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "watch.delete", req: rid(), conn: this.conn, watchId })
  }

  toggleWatch(watchId: string, enabled: boolean): Promise<PhoneCommandResult> {
    return this.request({ type: "watch.toggle", req: rid(), conn: this.conn, watchId, enabled })
  }

  resumeWatch(watchId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "watch.resume", req: rid(), conn: this.conn, watchId })
  }

  openChallenge(): Promise<PhoneCommandResult> {
    return this.request({ type: "challenge.open", req: rid(), conn: this.conn })
  }

  completeChallenge(): Promise<PhoneCommandResult> {
    return this.request({ type: "challenge.done", req: rid(), conn: this.conn })
  }

  dismissChallenge(): Promise<PhoneCommandResult> {
    return this.request({ type: "challenge.dismiss", req: rid(), conn: this.conn })
  }

  submitChallenge(cookie: string): Promise<PhoneCommandResult> {
    return this.request({ type: "challenge.submit", req: rid(), conn: this.conn, cookie })
  }

  openAccountLogin(accountId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "account.login", req: rid(), conn: this.conn, accountId })
  }

  bulkTasks(input: { text: string; store: StoreId; quantity: number; profileId: string; accountId: string; proxyGroupId: string | null; confirmPurchase: boolean; testMode: boolean; group: string }): Promise<PhoneCommandResult> {
    return this.request({ type: "task.bulk", req: rid(), conn: this.conn, ...input })
  }

  duplicateTask(taskId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "task.duplicate", req: rid(), conn: this.conn, taskId })
  }

  saveSchedule(input: { name: string; startAt: string; stopAt: string; warmupMin: number; group: string; taskIds: string[] }): Promise<PhoneCommandResult> {
    return this.request({ type: "schedule.save", req: rid(), conn: this.conn, ...input })
  }

  deleteSchedule(scheduleId: string): Promise<PhoneCommandResult> {
    return this.request({ type: "schedule.delete", req: rid(), conn: this.conn, scheduleId })
  }

  analyticsCsv(): Promise<PhoneCommandResult> {
    return this.request({ type: "analytics.csv", req: rid(), conn: this.conn })
  }

  saveProfile(profile: import("./desk").PhoneProfileDraft): Promise<PhoneCommandResult> {
    return this.request({ type: "profile.save", req: rid(), conn: this.conn, profile })
  }

  deleteProfile(id: string): Promise<PhoneCommandResult> {
    return this.request({ type: "profile.delete", req: rid(), conn: this.conn, id })
  }

  saveAccount(account: import("./desk").PhoneAccountDraft): Promise<PhoneCommandResult> {
    return this.request({ type: "account.save", req: rid(), conn: this.conn, account })
  }

  deleteAccount(id: string): Promise<PhoneCommandResult> {
    return this.request({ type: "account.delete", req: rid(), conn: this.conn, id })
  }

  warmAccount(id: string): Promise<PhoneCommandResult> {
    return this.request({ type: "account.warm", req: rid(), conn: this.conn, id })
  }

  saveProxy(proxy: import("./desk").PhoneProxyDraft): Promise<PhoneCommandResult> {
    return this.request({ type: "proxy.save", req: rid(), conn: this.conn, proxy })
  }

  deleteProxy(id: string): Promise<PhoneCommandResult> {
    return this.request({ type: "proxy.delete", req: rid(), conn: this.conn, id })
  }

  saveClient(client: import("./desk").PhoneClientDraft): Promise<PhoneCommandResult> {
    return this.request({ type: "client.save", req: rid(), conn: this.conn, client })
  }

  deleteClient(id: string): Promise<PhoneCommandResult> {
    return this.request({ type: "client.delete", req: rid(), conn: this.conn, id })
  }

  markLedger(clientId: string, ids: string[], paid: boolean): Promise<PhoneCommandResult> {
    return this.request({ type: "ledger.paid", req: rid(), conn: this.conn, clientId, ids, paid })
  }

  ledgerCsv(clientId = ""): Promise<PhoneCommandResult> {
    return this.request({ type: "ledger.csv", req: rid(), conn: this.conn, clientId })
  }

  saveDeskSettings(settings: import("./desk").PhoneSettingsDraft): Promise<PhoneCommandResult> {
    return this.request({ type: "settings.save", req: rid(), conn: this.conn, settings })
  }

  quickSetup(setup: import("./desk").PhoneQuickDraft): Promise<PhoneCommandResult> {
    return this.request({ type: "quick.setup", req: rid(), conn: this.conn, setup })
  }

  private async request(message: ClientMessage): Promise<PhoneCommandResult> {
    if (!("req" in message)) throw new Error("Phone request is missing an id.")
    const req = message.req
    const pending = this.waitFor((item) => item.type === "result" && item.req === req)
    this.send(message)
    const response = await pending
    if (response.type !== "result") throw new Error("The PC did not answer.")
    if (!response.ok) return { ok: false, error: response.error }
    return { ok: true, started: response.started, errors: response.errors, task: response.task, health: response.health, alerts: response.alerts, csv: response.csv, created: response.created, cookie: response.cookie }
  }

  private send(message: ClientMessage): void {
    if (!this.socket || !this.key) throw new Error("The phone is not connected to the PC.")
    const frame = seal(this.key, message, { mode: this.mode, pcId: this.pcId, rid: this.relay ? this.relayId : undefined })
    if (this.relay) this.socket.send(JSON.stringify({ op: "send", pc: this.pcId, body: frame }))
    else this.socket.send(frame)
  }

  private async openTransport(payload: PairingPayload, options?: ConnectOptions): Promise<void> {
    this.closeSockets()
    this.seen.clear()
    this.inbox = []
    this.rawInbox = []
    this.conn = ""
    const routes = options?.routes ?? ["direct", "relay"]
    const timeout = options?.directTimeoutMs ?? 4000
    let last = "Could not reach the PC."
    for (const route of routes) {
      try {
        if (route === "direct") await this.openDirect(payload, timeout)
        else await this.openRelay(payload, timeout)
        this.setOnline(true)
        return
      } catch (err) {
        last = err instanceof Error ? err.message : last
      }
    }
    throw new Error(last)
  }

  private openDirect(payload: PairingPayload, timeoutMs: number): Promise<void> {
    this.relay = false
    this.relayId = ""
    return this.openSocket(`ws://${payload.host}:${payload.port}`, timeoutMs)
  }

  private async openRelay(payload: PairingPayload, timeoutMs: number): Promise<void> {
    if (!payload.relay) throw new Error("No relay is configured on the PC.")
    this.relay = true
    await this.openSocket(payload.relay, timeoutMs)
    this.socket?.send(JSON.stringify({ op: "join", role: "phone", pc: payload.pcId }))
    const joined = await this.waitRaw(timeoutMs)
    const parsed = JSON.parse(joined) as { op?: string; id?: string }
    if (parsed.op !== "joined" || !parsed.id) throw new Error("The relay did not accept this phone.")
    this.relayId = parsed.id
  }

  private openSocket(url: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      let opened = false
      let settled = false
      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      const timer = setTimeout(() => {
        socket.close()
        finish(new Error("Timed out reaching the PC."))
      }, timeoutMs)
      socket.addEventListener("open", () => {
        opened = true
        this.socket = socket
        finish()
      })
      socket.addEventListener("error", () => {
        if (!opened) finish(new Error("Could not open a connection to the PC."))
      })
      socket.addEventListener("message", (event) => {
        const text = typeof event.data === "string" ? event.data : ""
        if (!text) return
        this.accept(text)
      })
      socket.addEventListener("close", (event) => {
        if (!opened) {
          finish(new Error("Could not open a connection to the PC."))
          return
        }
        if (this.socket !== socket) return
        this.socket = null
        this.setOnline(false)
        if (event.code === 4003) this.link = null
        this.failWaiters(event.code === 4003 ? new PhoneRevoked() : new Error("The PC connection closed."))
      })
    })
  }

  private accept(text: string): void {
    let body = text
    if (this.relay) {
      try {
        const outer = JSON.parse(text) as { op?: string; body?: string; id?: string }
        if (outer.op === "joined") {
          this.deliverRaw(text)
          return
        }
        if (outer.op !== "deliver" || typeof outer.body !== "string") return
        body = outer.body
      } catch {
        return
      }
    }
    if (!this.key) return
    try {
      const frame = parseFrame(body)
      if (frame.pcId !== this.pcId) return
      const message = openFrame(this.key, frame, Date.now(), this.seen) as ServerMessage
      this.dispatch(message)
    } catch {
      // Ignore frames we cannot decrypt. They belong to another device or a stale key.
    }
  }

  private dispatch(message: ServerMessage): void {
    if (message.type === "snapshot") {
      this.conn = message.conn
      this.onSnapshotCb?.(message.snapshot)
    } else if (message.type === "task") this.onTaskCb?.(message.task)
    else if (message.type === "task.deleted") this.onDeletedCb?.(message.id)
    else if (message.type === "notice") this.onNoticeCb?.(message.notice)
    else if (message.type === "alerts") this.onAlertsCb?.(message.alerts)
    else if (message.type === "challenge") this.onChallengeCb?.(message.challenge)
    else if (message.type === "vault.session") this.onVaultCb?.(message.accountId, message.cookie)
    else if (message.type === "presence") this.setOnline(true)
    const index = this.waiters.findIndex((waiter) => waiter.match(message))
    if (index < 0) {
      if (message.type !== "vault.session") this.inbox.push(message)
      return
    }
    const [waiter] = this.waiters.splice(index, 1)
    clearTimeout(waiter.timer)
    waiter.resolve(message)
  }

  private waitFor(match: (message: ServerMessage) => boolean, timeoutMs = 8000): Promise<ServerMessage> {
    const queued = this.inbox.findIndex(match)
    if (queued >= 0) return Promise.resolve(this.inbox.splice(queued, 1)[0])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer)
        reject(new Error("The PC did not answer."))
      }, timeoutMs)
      this.waiters.push({ match, resolve, reject, timer })
    })
  }

  private rawWaiters: { resolve: (text: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }[] = []

  private waitRaw(timeoutMs: number): Promise<string> {
    const queued = this.rawInbox.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The relay did not answer.")), timeoutMs)
      this.rawWaiters.push({
        resolve: (text) => {
          clearTimeout(timer)
          resolve(text)
        },
        reject,
        timer
      })
    })
  }

  private deliverRaw(text: string): void {
    const waiter = this.rawWaiters.shift()
    if (!waiter) {
      this.rawInbox.push(text)
      return
    }
    clearTimeout(waiter.timer)
    waiter.resolve(text)
  }

  private failWaiters(err: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    this.waiters = []
    for (const waiter of this.rawWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    this.rawWaiters = []
  }

  private closeSockets(): void {
    this.socket?.close()
    this.socket = null
  }

  private setOnline(online: boolean): void {
    this.online = online
    this.onOnlineCb?.(online)
  }
}

export function payloadFromScan(text: string): PairingPayload {
  return parsePairingPayload(text.trim())
}

export function pairingText(payload: PairingPayload): string {
  return encodePairingPayload(payload)
}

function rid(): string {
  return Math.random().toString(36).slice(2, 12)
}
