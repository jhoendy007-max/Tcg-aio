import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http"
import { WebSocket, WebSocketServer } from "ws"
import { readHttpBody } from "../engine/body"
import { redact } from "../shared/redact"
import { lanIPv4 } from "./net"
import {
  INVITE_TTL_MS,
  asClientMessage,
  cleanDeviceName,
  openFrame,
  pairKey,
  parseFrame,
  randomId,
  randomSecret,
  seal,
  sessionKey,
  type ClientMessage,
  type PairingPayload,
  type PhoneDevice,
  type PhoneAlerts,
  type PhoneChallenge,
  type PhoneNotice,
  type PhoneSnapshot,
  type PhoneStatus,
  type PhoneTask,
  type PhoneTaskDraft,
  type ServerMessage
} from "./protocol"

export interface PhoneHost {
  pcId: string
  pcName: string
  relayUrl(): string
  provisionRelay?(): Promise<{ url: string; channel: string; pcToken: string; inviteToken: string }>
  /** True when a hosted relay channel was saved and this PC is signed in, so it can rejoin without a new invite. */
  canResumeRelay?(): boolean
  log?(line: string): void
  issueRelayDevice?(deviceId: string): Promise<string | undefined>
  revokeRelayDevice?(deviceId: string): Promise<void> | void
  snapshot(): PhoneSnapshot
  saveTask(draft: PhoneTaskDraft): PhoneTask
  deleteTask(id: string): void
  start(id: string, options?: { test?: boolean }): void
  checkHealth(proxyGroupId: string | null): Promise<import("../shared/types").StoreHealth[]>
  stop(id: string): void
  startAll(): { started: string[]; errors: { id: string; error: string }[] }
  stopAll(): void
  pauseAll?(): void
  setAutopilot?(enabled: boolean): void
  setLanguage?(language: "en" | "es"): void
  saveMailbox?(input: import("./protocol").PhoneMailDraft): void
  deleteMailbox?(id: string): void
  signInMail?(input: { provider: "gmail" | "outlook"; user: string }): Promise<void>
  saveModule?(store: import("../shared/types").StoreId, record: import("../shared/types").ModuleRecord): void
  resetModule?(store: import("../shared/types").StoreId): void
  importModule?(text: string): void
  devices(): PhoneDevice[]
  deviceTokens(): { id: string; name: string; token: string }[]
  saveDevice(device: { id: string; name: string; token: string }): void
  revokeDevice(id: string): void
  touchDevice(id: string): void
  alerts?(): PhoneAlerts
  saveRule?(input: import("../shared/types").RestockRuleInput): PhoneAlerts
  deleteRule?(id: string): PhoneAlerts
  toggleRule?(id: string, enabled: boolean): PhoneAlerts
  saveWatch?(input: import("../shared/types").KeywordWatchInput): PhoneAlerts
  deleteWatch?(id: string): PhoneAlerts
  toggleWatch?(id: string, enabled: boolean): PhoneAlerts
  resumeWatch?(id: string): PhoneAlerts
  openChallenge?(): Promise<void> | void
  completeChallenge?(): Promise<void> | void
  dismissChallenge?(): void
  submitChallenge?(cookie: string): void
  currentChallenge?(): PhoneChallenge | null
  openAccountLogin?(id: string): Promise<void> | void
  bulkTasks?(input: { text: string; store: import("../shared/types").StoreId; quantity: number; profileId: string; accountId: string; proxyGroupId: string | null; confirmPurchase: boolean; testMode: boolean; group: string }): { created: number; errors?: { id: string; error: string }[] }
  duplicateTask?(id: string): PhoneTask
  saveSchedule?(input: { name: string; startAt: string; stopAt: string; warmupMin: number; group: string; taskIds: string[] }): void
  deleteSchedule?(id: string): void
  analyticsCsv?(): string
  linkVault?(deviceId: string, accountId: string, twoWay: boolean): void
  unlinkVault?(deviceId: string, accountId: string): void
  pushVault?(deviceId: string, accountId: string, cookie: string, expiresAt: number | null): void
  pullVault?(deviceId: string, accountId: string): string
  twoWayDevices?(accountId: string): string[]
  saveProfile?(input: import("./desk").PhoneProfileDraft): void
  deleteProfile?(id: string): void
  saveAccount?(input: import("./desk").PhoneAccountDraft): void
  deleteAccount?(id: string): void
  warmAccount?(id: string): Promise<{ expired: boolean; detail: string }>
  saveProxy?(input: import("./desk").PhoneProxyDraft): void
  deleteProxy?(id: string): void
  saveClient?(input: import("./desk").PhoneClientDraft): void
  deleteClient?(id: string): void
  markLedger?(clientId: string, ids: string[], paid: boolean): void
  ledgerCsv?(clientId?: string): string
  saveDeskSettings?(input: import("./desk").PhoneSettingsDraft): void
  quickSetup?(input: import("./desk").PhoneQuickDraft): { created: number }
}

interface DeviceKey {
  id: string
  name: string
  key: Uint8Array
}

interface Conn {
  ws: WebSocket | null
  rid?: string
  key: Uint8Array | null
  deviceId: string | null
  connId: string | null
  fails: number
  via?: "hosted" | "legacy"
}

interface Invite {
  secret: string
  key: Uint8Array
  expiresAt: number
}

export class PhoneServer {
  port = 0
  private http: HttpServer | null = null
  private wss: WebSocketServer | null = null
  private invite: Invite | null = null
  private keys: DeviceKey[] = []
  private seen = new Set<string>()
  private conns = new Set<Conn>()
  private relayConns = new Map<string, Conn>()
  private relaySocket: WebSocket | null = null
  private relayTimer: ReturnType<typeof setTimeout> | null = null
  private hosted: { url: string; channel: string; pcToken: string; inviteToken: string } | null = null
  private hostedSocket: WebSocket | null = null
  private hostedTimer: ReturnType<typeof setTimeout> | null = null
  private resumeTimer: ReturnType<typeof setTimeout> | null = null
  private resumeAttempt = 0
  private relayStopped = false
  private readonly bindHost: string
  private readonly advertiseHost: string
  private readonly now: () => number
  private restock?: (authorization: string | undefined, alternate: string | undefined, body: string) => Promise<{ status: number; body: string }>

  constructor(
    private readonly host: PhoneHost,
    options?: {
      bindHost?: string
      advertiseHost?: string
      port?: number
      now?: () => number
      onDevices?: () => void
    }
  ) {
    this.bindHost = options?.bindHost ?? "0.0.0.0"
    this.advertiseHost = options?.advertiseHost ?? (this.bindHost === "0.0.0.0" ? lanIPv4() : this.bindHost)
    this.port = options?.port ?? 47321
    this.now = options?.now ?? Date.now
    this.onDevices = options?.onDevices
  }

  private readonly onDevices?: () => void

  start(): Promise<void> {
    if (this.http) return Promise.resolve()
    this.refreshKeys()
    const http = createServer((req, res) => {
      void this.onRequest(req, res)
    })
    const wss = new WebSocketServer({ server: http, maxPayload: 256_000, perMessageDeflate: false })
    wss.on("connection", (ws) => {
      const conn = this.blank(ws)
      this.conns.add(conn)
      const timer = setTimeout(() => {
        if (!conn.deviceId) this.fail(conn, 4001)
      }, 8000)
      ws.on("message", (data) => this.onFrame(conn, data.toString()))
      ws.on("close", () => {
        clearTimeout(timer)
        this.conns.delete(conn)
      })
      ws.on("error", () => this.fail(conn, 4000))
    })
    this.http = http
    this.wss = wss
    return new Promise((resolve, reject) => {
      http.once("error", reject)
      http.listen(this.port, this.bindHost, () => {
        const address = http.address()
        this.port = typeof address === "object" && address ? address.port : this.port
        this.reconnectRelay()
        this.resumeRelay()
        resolve()
      })
    })
  }

  async prepareRelay(): Promise<void> {
    if (!this.host.provisionRelay) return
    this.hosted = await this.host.provisionRelay()
    this.relayStopped = false
    this.resumeAttempt = 0
    this.reconnectHosted()
  }

  /**
   * Rejoin the saved hosted relay channel in the background (startup, sign-in, license refresh).
   * Before 0.2.36 only the pairing screen did this, so after a PC restart the phone saw "The PC did not answer."
   * Retries with backoff: 2s, 4s, 8s ... up to 5 min.
   */
  resumeRelay(force = false): void {
    if (force) this.relayStopped = false
    if (this.relayStopped) return
    if (!this.http || !this.host.provisionRelay || !this.host.canResumeRelay?.()) return
    if (this.hostedSocket || this.resumeTimer) return
    void this.prepareRelay().catch((error: unknown) => {
      const delay = Math.min(300_000, 2000 * 2 ** this.resumeAttempt)
      this.resumeAttempt += 1
      this.host.log?.(`[relay] pc resume failed (${error instanceof Error ? error.message : String(error)}); retry in ${Math.round(delay / 1000)}s`)
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null
        this.resumeRelay()
      }, delay)
    })
  }

  async stop(): Promise<void> {
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = null
    if (this.relayTimer) clearTimeout(this.relayTimer)
    this.relayTimer = null
    this.relaySocket?.close()
    this.relaySocket = null
    if (this.hostedTimer) clearTimeout(this.hostedTimer)
    this.hostedTimer = null
    this.hostedSocket?.close()
    this.hostedSocket = null
    for (const conn of this.conns) conn.ws?.close()
    this.conns.clear()
    this.relayConns.clear()
    this.wss?.close()
    const http = this.http
    this.http = null
    this.wss = null
    this.invite = null
    if (!http) return
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  createInvite(): PairingPayload {
    if (!this.http) throw new Error("The phone listener is not running.")
    const secret = randomSecret()
    this.invite = { secret, key: pairKey(secret), expiresAt: this.now() + INVITE_TTL_MS }
    const hosted = this.hosted
    const relay = hosted?.url || this.host.relayUrl()
    return {
      v: 1,
      pcId: this.host.pcId,
      name: this.host.pcName.slice(0, 60),
      host: this.advertiseHost,
      port: this.port,
      secret,
      ...(relay ? { relay } : {}),
      ...(hosted ? { relayChannel: hosted.channel, relayToken: hosted.inviteToken } : {})
    }
  }

  setRestock(handler: (authorization: string | undefined, alternate: string | undefined, body: string) => Promise<{ status: number; body: string }>): void {
    this.restock = handler
  }

  publishAlerts(alerts: PhoneAlerts): void {
    this.broadcast({ type: "alerts", alerts })
  }

  publishChallenge(challenge: PhoneChallenge | null): void {
    this.broadcast({
      type: "challenge",
      challenge: challenge
        ? { ...challenge, reason: redact(challenge.reason).slice(0, 500), cookie: challenge.cookie.slice(0, 8192) }
        : null
    })
  }

  status(): PhoneStatus {
    const inviteExpiresAt = this.invite && this.invite.expiresAt > this.now() ? this.invite.expiresAt : null
    return {
      listening: Boolean(this.http),
      host: this.advertiseHost,
      port: this.port,
      relay: this.hosted?.url || this.host.relayUrl(),
      pcName: this.host.pcName,
      devices: this.host.devices(),
      inviteExpiresAt
    }
  }

  revoke(id: string): void {
    this.host.revokeDevice(id)
    void this.host.revokeRelayDevice?.(id)
    this.refreshKeys()
    for (const conn of [...this.conns]) {
      if (conn.deviceId === id) this.fail(conn, 4003)
    }
    this.onDevices?.()
  }

  reconnectRelay(): void {
    this.relaySocket?.close()
    this.relaySocket = null
    if (this.relayTimer) clearTimeout(this.relayTimer)
    this.relayTimer = null
    const url = this.host.relayUrl()
    if (!url || !this.http) return
    const socket = new WebSocket(url)
    this.relaySocket = socket
    socket.on("open", () => {
      socket.send(JSON.stringify({ op: "join", role: "pc", pc: this.host.pcId }))
    })
    socket.on("message", (data) => this.onRelay(data.toString(), "legacy"))
    socket.on("close", () => {
      if (this.relaySocket !== socket) return
      this.relaySocket = null
      if (!this.host.relayUrl() || !this.http) return
      this.relayTimer = setTimeout(() => this.reconnectRelay(), 3000)
    })
    socket.on("error", () => socket.close())
  }

  private reconnectHosted(): void {
    this.hostedSocket?.close()
    this.hostedSocket = null
    if (this.hostedTimer) clearTimeout(this.hostedTimer)
    this.hostedTimer = null
    const hosted = this.hosted
    if (!hosted || !this.http) return
    const socket = new WebSocket(hosted.url)
    this.hostedSocket = socket
    socket.on("open", () => {
      socket.send(JSON.stringify({ op: "join", role: "pc", channel: hosted.channel, token: hosted.pcToken, pc: this.host.pcId }))
      this.host.log?.(`[relay] pc joined channel ${hosted.channel.slice(0, 8)}`)
    })
    socket.on("message", (data) => this.onRelay(data.toString(), "hosted"))
    socket.on("close", (code: number) => {
      if (this.hostedSocket !== socket) return
      this.hostedSocket = null
      this.host.log?.(`[relay] pc left channel ${hosted.channel.slice(0, 8)} code ${code}`)
      if (!this.hosted || !this.http) return
      if (code === 4001) {
        // The relay refused this PC for good (signed out / revoked). Wait for a new invite or sign-in.
        this.relayStopped = true
        this.hosted = null
        return
      }
      if (code === 4003) {
        // Channel token no longer valid: ask the license server for a fresh one.
        this.hosted = null
        this.resumeAttempt = 0
        this.hostedTimer = setTimeout(() => {
          this.hostedTimer = null
          this.resumeRelay()
        }, 1000)
        return
      }
      this.hostedTimer = setTimeout(() => this.reconnectHosted(), 3000)
    })
    socket.on("error", () => socket.close())
  }

  publishTask(task: PhoneTask): void {
    this.broadcast({ type: "task", task })
  }

  publishDelete(id: string): void {
    this.broadcast({ type: "task.deleted", id })
  }

  publishSnapshot(): void {
    this.broadcast({ type: "snapshot", conn: "", snapshot: this.host.snapshot() })
  }

  publishNotice(notice: PhoneNotice): void {
    this.broadcast({
      type: "notice",
      notice: { ...notice, detail: redact(notice.detail).slice(0, 240), sku: notice.sku.slice(0, 180) }
    })
  }

  private refreshKeys(): void {
    this.keys = this.host.deviceTokens().map((device) => ({
      id: device.id,
      name: device.name,
      key: sessionKey(device.token)
    }))
  }

  private blank(ws: WebSocket | null, rid?: string): Conn {
    return { ws, rid, key: null, deviceId: null, connId: null, fails: 0 }
  }

  private onRelay(text: string, via: "hosted" | "legacy"): void {
    let value: { op?: string; from?: string; body?: string; id?: string; authorization?: string; token?: string }
    try {
      value = JSON.parse(text) as typeof value
    } catch {
      return
    }
    if (value.op === "restock" && typeof value.id === "string") {
      void this.answerRestock(value)
      return
    }
    if (value.op !== "deliver" || typeof value.body !== "string" || typeof value.from !== "string") return
    let conn = this.relayConns.get(value.from)
    if (!conn) {
      conn = this.blank(null, value.from)
      conn.via = via
      this.relayConns.set(value.from, conn)
      this.conns.add(conn)
    }
    this.onFrame(conn, value.body)
  }

  private onFrame(conn: Conn, text: string): void {
    let frame
    try {
      frame = parseFrame(text)
    } catch {
      this.fail(conn, 4000)
      return
    }
    if (frame.pcId !== this.host.pcId) {
      this.fail(conn, 4000)
      return
    }
    if (frame.rid && !conn.rid) conn.rid = frame.rid
    try {
      if (frame.mode === "pair") void this.onPair(conn, frame)
      else this.onSession(conn, frame)
    } catch (err) {
      const message = safeError(err)
      if (conn.key && conn.connId) this.send(conn, conn.key, "session", { type: "error", error: message })
      else this.fail(conn, frame.mode === "pair" ? 4001 : 4003)
    }
  }

  private async onPair(conn: Conn, frame: ReturnType<typeof parseFrame>): Promise<void> {
    if (!this.invite || this.invite.expiresAt <= this.now()) {
      this.invite = null
      this.fail(conn, 4001)
      return
    }
    const message = asClientMessage(openFrame(this.invite.key, frame, Date.now(), this.seen))
    if (message.type !== "pair") throw new Error("Pairing must be the first message.")
    const name = cleanDeviceName(message.deviceName)
    const token = randomSecret()
    const deviceId = randomId()
    const key = this.invite.key
    this.host.saveDevice({ id: deviceId, name, token })
    this.invite = null
    this.refreshKeys()
    let relayToken = ""
    if (this.hosted && this.host.issueRelayDevice) {
      try {
        relayToken = (await this.host.issueRelayDevice(deviceId)) ?? ""
      } catch {
        relayToken = ""
      }
    }
    this.send(conn, key, "pair", {
      type: "paired",
      token,
      deviceId,
      pcName: this.host.pcName,
      ...(relayToken && this.hosted ? { relayToken, relay: this.hosted.url, relayChannel: this.hosted.channel } : {})
    })
    this.onDevices?.()
  }

  private onSession(conn: Conn, frame: ReturnType<typeof parseFrame>): void {
    const opened = this.openSession(frame)
    if (!opened) {
      conn.fails += 1
      if (conn.fails >= 5) this.fail(conn, 4003)
      return
    }
    conn.fails = 0
    conn.key = opened.key
    conn.deviceId = opened.id
    if (opened.message.type === "hello") {
      conn.connId = randomId()
      this.host.touchDevice(opened.id)
      this.send(conn, opened.key, "session", { type: "presence", online: true, pcName: this.host.pcName })
      this.send(conn, opened.key, "session", { type: "snapshot", conn: conn.connId, snapshot: this.host.snapshot() })
      this.sendChallenge(conn, opened.key)
      return
    }
    this.handle(conn, opened.message)
  }

  private openSession(frame: ReturnType<typeof parseFrame>): (DeviceKey & { message: ClientMessage }) | null {
    for (const device of this.keys) {
      try {
        const message = asClientMessage(openFrame(device.key, frame, Date.now(), this.seen))
        return { ...device, message }
      } catch {
        // Try the next paired phone. A wrong key fails the AES-GCM tag.
      }
    }
    return null
  }

  private async handle(conn: Conn, message: ClientMessage): Promise<void> {
    if (message.type === "pair" || message.type === "hello") throw new Error("The phone is already paired.")
    if (!conn.connId || message.conn !== conn.connId) throw new Error("Phone session is not ready.")
    const req = message.req
    try {
      if (message.type === "sync") {
        this.send(conn, conn.key!, "session", { type: "result", req, ok: true })
        this.send(conn, conn.key!, "session", { type: "snapshot", conn: conn.connId, snapshot: this.host.snapshot() })
        this.sendChallenge(conn, conn.key!)
        return
      }
      if (message.type === "task.start") {
        this.host.start(message.taskId)
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "task.test") {
        this.host.start(message.taskId, { test: true })
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "health.check") {
        const health = await this.host.checkHealth(message.proxyGroupId)
        this.reply(conn, req, { ok: true, health })
        return
      }
      if (message.type === "task.stop") {
        this.host.stop(message.taskId)
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "task.startAll") {
        const outcome = this.host.startAll()
        this.reply(conn, req, { ok: true, started: outcome.started, errors: outcome.errors })
        return
      }
      if (message.type === "task.stopAll" || message.type === "task.pauseAll") {
        if (message.type === "task.pauseAll" && this.host.pauseAll) this.host.pauseAll()
        else this.host.stopAll()
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "autopilot.set") {
        if (!this.host.setAutopilot) throw new Error("Autopilot is not available.")
        this.host.setAutopilot(message.enabled)
        this.reply(conn, req, { ok: true })
        this.broadcast({ type: "snapshot", conn: "", snapshot: this.host.snapshot() })
        return
      }
      if (message.type === "language.set") {
        if (!this.host.setLanguage) throw new Error("Language is not available.")
        this.host.setLanguage(message.language)
        this.reply(conn, req, { ok: true })
        this.broadcast({ type: "snapshot", conn: "", snapshot: this.host.snapshot() })
        return
      }
      if (message.type === "mail.save") {
        if (!this.host.saveMailbox) throw new Error("Mail is not available.")
        this.host.saveMailbox(message.mailbox)
        this.reply(conn, req, { ok: true })
        this.broadcast({ type: "snapshot", conn: "", snapshot: this.host.snapshot() })
        return
      }
      if (message.type === "mail.delete") {
        if (!this.host.deleteMailbox) throw new Error("Mail is not available.")
        this.host.deleteMailbox(message.id)
        this.reply(conn, req, { ok: true })
        this.broadcast({ type: "snapshot", conn: "", snapshot: this.host.snapshot() })
        return
      }
      if (message.type === "mail.oauth") {
        if (!this.host.signInMail) throw new Error("Mail sign-in is not available.")
        await this.host.signInMail({ provider: message.provider, user: message.user })
        this.reply(conn, req, { ok: true })
        this.broadcast({ type: "snapshot", conn: "", snapshot: this.host.snapshot() })
        return
      }
      if (message.type === "module.save" || message.type === "module.reset" || message.type === "module.import") {
        if (message.type === "module.save") {
          if (!this.host.saveModule) throw new Error("Store settings are not available.")
          this.host.saveModule(message.store, message.record)
        } else if (message.type === "module.reset") {
          if (!this.host.resetModule) throw new Error("Store settings are not available.")
          this.host.resetModule(message.store)
        } else {
          if (!this.host.importModule) throw new Error("Store settings are not available.")
          this.host.importModule(message.text)
        }
        this.reply(conn, req, { ok: true })
        this.broadcast({ type: "snapshot", conn: "", snapshot: this.host.snapshot() })
        return
      }
      if (message.type === "task.save") {
        const task = this.host.saveTask(message.task)
        this.broadcast({ type: "task", task })
        this.reply(conn, req, { ok: true, task })
        return
      }
      if (message.type === "task.delete") {
        this.host.deleteTask(message.taskId)
        this.broadcast({ type: "task.deleted", id: message.taskId })
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "rule.save") {
        const alerts = this.requireAlerts().saveRule?.(message.rule)
        if (!alerts) throw new Error("Restock rules are not available.")
        this.publishAlerts(alerts)
        this.reply(conn, req, { ok: true, alerts })
        return
      }
      if (message.type === "rule.delete") {
        const alerts = this.requireAlerts().deleteRule?.(message.ruleId)
        if (!alerts) throw new Error("Restock rules are not available.")
        this.publishAlerts(alerts)
        this.reply(conn, req, { ok: true, alerts })
        return
      }
      if (message.type === "rule.toggle") {
        const alerts = this.requireAlerts().toggleRule?.(message.ruleId, message.enabled)
        if (!alerts) throw new Error("Restock rules are not available.")
        this.publishAlerts(alerts)
        this.reply(conn, req, { ok: true, alerts })
        return
      }
      if (message.type === "watch.save") {
        const alerts = this.requireAlerts().saveWatch?.(message.watch)
        if (!alerts) throw new Error("Keyword watches are not available.")
        this.publishAlerts(alerts)
        this.reply(conn, req, { ok: true, alerts })
        return
      }
      if (message.type === "watch.delete") {
        const alerts = this.requireAlerts().deleteWatch?.(message.watchId)
        if (!alerts) throw new Error("Keyword watches are not available.")
        this.publishAlerts(alerts)
        this.reply(conn, req, { ok: true, alerts })
        return
      }
      if (message.type === "watch.toggle") {
        const alerts = this.requireAlerts().toggleWatch?.(message.watchId, message.enabled)
        if (!alerts) throw new Error("Keyword watches are not available.")
        this.publishAlerts(alerts)
        this.reply(conn, req, { ok: true, alerts })
        return
      }
      if (message.type === "watch.resume") {
        const alerts = this.requireAlerts().resumeWatch?.(message.watchId)
        if (!alerts) throw new Error("Keyword watches are not available.")
        this.publishAlerts(alerts)
        this.reply(conn, req, { ok: true, alerts })
        return
      }
      if (message.type === "challenge.open") {
        if (!this.host.openChallenge) throw new Error("Challenge handoff is not available.")
        await this.host.openChallenge()
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "challenge.done") {
        if (!this.host.completeChallenge) throw new Error("Challenge handoff is not available.")
        await this.host.completeChallenge()
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "challenge.dismiss") {
        if (!this.host.dismissChallenge) throw new Error("Challenge handoff is not available.")
        this.host.dismissChallenge()
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "challenge.submit") {
        if (!this.host.submitChallenge) throw new Error("Challenge handoff is not available.")
        this.host.submitChallenge(message.cookie)
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "account.login") {
        if (!this.host.openAccountLogin) throw new Error("Browser sign-in is not available.")
        await this.host.openAccountLogin(message.accountId)
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "task.bulk") {
        if (!this.host.bulkTasks) throw new Error("Mass task creation is not available.")
        const result = this.host.bulkTasks(message)
        this.reply(conn, req, { ok: true, created: result.created, errors: result.errors })
        this.publishSnapshot()
        return
      }
      if (message.type === "task.duplicate") {
        if (!this.host.duplicateTask) throw new Error("Duplicate is not available.")
        const task = this.host.duplicateTask(message.taskId)
        this.reply(conn, req, { ok: true, task, created: 1 })
        this.broadcast({ type: "task", task })
        return
      }
      if (message.type === "schedule.save") {
        if (!this.host.saveSchedule) throw new Error("The drop scheduler is not available.")
        this.host.saveSchedule(message)
        this.reply(conn, req, { ok: true })
        this.publishSnapshot()
        return
      }
      if (message.type === "schedule.delete") {
        if (!this.host.deleteSchedule) throw new Error("The drop scheduler is not available.")
        this.host.deleteSchedule(message.scheduleId)
        this.reply(conn, req, { ok: true })
        this.publishSnapshot()
        return
      }
      if (message.type === "analytics.csv") {
        if (!this.host.analyticsCsv) throw new Error("Checkout history is not available.")
        this.reply(conn, req, { ok: true, csv: this.host.analyticsCsv() })
        return
      }
      if (!conn.deviceId) throw new Error("This browser is not paired.")
      if (message.type === "vault.link") {
        if (!this.host.linkVault) throw new Error("Session sync is not available.")
        this.host.linkVault(conn.deviceId, message.accountId, message.twoWay)
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "vault.unlink") {
        if (!this.host.unlinkVault) throw new Error("Session sync is not available.")
        this.host.unlinkVault(conn.deviceId, message.accountId)
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "vault.push") {
        if (!this.host.pushVault) throw new Error("Session sync is not available.")
        this.host.pushVault(conn.deviceId, message.accountId, message.cookie, message.expiresAt)
        this.reply(conn, req, { ok: true })
        return
      }
      if (message.type === "vault.pull") {
        if (!this.host.pullVault) throw new Error("Session sync is not available.")
        this.reply(conn, req, { ok: true, cookie: this.host.pullVault(conn.deviceId, message.accountId) })
        return
      }
      if (await this.desk(conn, req, message)) return
    } catch (err) {
      this.reply(conn, req, { ok: false, error: safeError(err) })
    }
  }

  pushVaultSession(accountId: string, cookie: string): void {
    const devices = new Set(this.host.twoWayDevices?.(accountId) ?? [])
    if (!devices.size || !cookie) return
    for (const conn of this.conns) {
      if (!conn.deviceId || !devices.has(conn.deviceId) || !conn.key) continue
      this.send(conn, conn.key, "session", { type: "vault.session", accountId, cookie })
    }
  }

  private async desk(conn: Conn, req: string, message: ClientMessage): Promise<boolean> {
    const host = this.host
    if (message.type === "profile.save") {
      if (!host.saveProfile) throw new Error("Profiles are not available on this PC.")
      host.saveProfile(message.profile)
    } else if (message.type === "profile.delete") {
      if (!host.deleteProfile) throw new Error("Profiles are not available on this PC.")
      host.deleteProfile(message.id)
    } else if (message.type === "account.save") {
      if (!host.saveAccount) throw new Error("Accounts are not available on this PC.")
      host.saveAccount(message.account)
    } else if (message.type === "account.delete") {
      if (!host.deleteAccount) throw new Error("Accounts are not available on this PC.")
      host.deleteAccount(message.id)
    } else if (message.type === "account.warm") {
      if (!host.warmAccount) throw new Error("Session warm-up runs on the PC.")
      const warmed = await host.warmAccount(message.id)
      this.broadcast({ type: "snapshot", conn: "", snapshot: host.snapshot() })
      this.reply(conn, req, { ok: true, created: warmed.expired ? 0 : 1 })
      return true
    } else if (message.type === "proxy.save") {
      if (!host.saveProxy) throw new Error("Proxies are not available on this PC.")
      host.saveProxy(message.proxy)
    } else if (message.type === "proxy.delete") {
      if (!host.deleteProxy) throw new Error("Proxies are not available on this PC.")
      host.deleteProxy(message.id)
    } else if (message.type === "client.save") {
      if (!host.saveClient) throw new Error("Clients are not available on this PC.")
      host.saveClient(message.client)
    } else if (message.type === "client.delete") {
      if (!host.deleteClient) throw new Error("Clients are not available on this PC.")
      host.deleteClient(message.id)
    } else if (message.type === "ledger.paid") {
      if (!host.markLedger) throw new Error("The charge log is not available on this PC.")
      host.markLedger(message.clientId, message.ids, message.paid)
    } else if (message.type === "ledger.csv") {
      if (!host.ledgerCsv) throw new Error("The charge log is not available on this PC.")
      this.reply(conn, req, { ok: true, csv: host.ledgerCsv(message.clientId || undefined) })
      return true
    } else if (message.type === "settings.save") {
      if (!host.saveDeskSettings) throw new Error("Settings are not available on this PC.")
      host.saveDeskSettings(message.settings)
    } else if (message.type === "quick.setup") {
      if (!host.quickSetup) throw new Error("Quick setup is not available on this PC.")
      const made = host.quickSetup(message.setup)
      this.broadcast({ type: "snapshot", conn: "", snapshot: host.snapshot() })
      this.reply(conn, req, { ok: true, created: made.created })
      return true
    } else {
      return false
    }
    this.broadcast({ type: "snapshot", conn: "", snapshot: host.snapshot() })
    this.reply(conn, req, { ok: true })
    return true
  }

  private reply(conn: Conn, req: string, body: { ok: true; started?: string[]; errors?: { id: string; error: string }[]; task?: PhoneTask; health?: import("../shared/types").StoreHealth[]; alerts?: PhoneAlerts; csv?: string; created?: number; cookie?: string } | { ok: false; error: string }): void {
    if (!conn.key) return
    this.send(conn, conn.key, "session", body.ok
      ? { type: "result", req, ok: true, started: body.started, errors: body.errors, task: body.task, health: body.health, alerts: body.alerts, csv: body.csv, created: body.created, cookie: body.cookie }
      : { type: "result", req, ok: false, error: body.error })
  }

  private broadcast(message: ServerMessage): void {
    for (const conn of this.conns) {
      if (!conn.deviceId || !conn.key || !conn.connId) continue
      this.send(conn, conn.key, "session", message)
    }
  }

  private send(conn: Conn, key: Uint8Array, mode: "pair" | "session", message: ServerMessage): void {
    const frame = seal(key, message, { mode, pcId: this.host.pcId })
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(frame)
      return
    }
    const outbound = conn.via === "hosted" ? this.hostedSocket : conn.via === "legacy" ? this.relaySocket : this.hostedSocket ?? this.relaySocket
    if (conn.rid && outbound && outbound.readyState === WebSocket.OPEN) {
      outbound.send(JSON.stringify({ op: "send", pc: this.host.pcId, to: conn.rid, body: frame }))
    }
  }

  private fail(conn: Conn, code: number): void {
    this.conns.delete(conn)
    if (conn.rid) this.relayConns.delete(conn.rid)
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) conn.ws.close(code)
  }

  private sendChallenge(conn: Conn, key: Uint8Array): void {
    const challenge = this.host.currentChallenge?.() ?? null
    if (!challenge) return
    this.send(conn, key, "session", {
      type: "challenge",
      challenge: { ...challenge, reason: redact(challenge.reason).slice(0, 500), cookie: challenge.cookie.slice(0, 8192) }
    })
  }

  private requireAlerts(): PhoneHost {
    if (!this.host.alerts) throw new Error("Alerts are not available.")
    return this.host
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = (req.url ?? "").split("?")[0]
      if (req.method === "POST" && path === "/v1/restock") {
        const raw = await readHttpBody(req, 32_000)
        const result = this.restock
          ? await this.restock(header(req, "authorization"), header(req, "x-tcgaio-token"), raw)
          : { status: 503, body: JSON.stringify({ ok: false, error: "Restock webhook is not ready." }) }
        res.writeHead(result.status, { "content-type": "application/json; charset=utf-8" })
        res.end(result.body)
        return
      }
      res.writeHead(404)
      res.end()
    } catch {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ ok: false, error: "Bad request." }))
    }
  }

  private async answerRestock(value: { id?: string; authorization?: string; token?: string; body?: string }): Promise<void> {
    const id = value.id ?? ""
    const result = this.restock
      ? await this.restock(value.authorization, value.token, value.body ?? "")
      : { status: 503, body: JSON.stringify({ ok: false, error: "Restock webhook is not ready." }) }
    if (this.relaySocket && this.relaySocket.readyState === WebSocket.OPEN) {
      this.relaySocket.send(JSON.stringify({ op: "restock-result", id, pc: this.host.pcId, status: result.status, body: result.body }))
    }
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Request failed."
  return message.replace(/\s+/g, " ").slice(0, 240)
}
