import { createServer, type Server as HttpServer } from "node:http"
import { WebSocket, WebSocketServer } from "ws"
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
  snapshot(): PhoneSnapshot
  saveTask(draft: PhoneTaskDraft): PhoneTask
  deleteTask(id: string): void
  start(id: string, options?: { test?: boolean }): void
  checkHealth(proxyGroupId: string | null): Promise<import("../shared/types").StoreHealth[]>
  stop(id: string): void
  startAll(): { started: string[]; errors: { id: string; error: string }[] }
  stopAll(): void
  devices(): PhoneDevice[]
  deviceTokens(): { id: string; name: string; token: string }[]
  saveDevice(device: { id: string; name: string; token: string }): void
  revokeDevice(id: string): void
  touchDevice(id: string): void
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
  private readonly bindHost: string
  private readonly advertiseHost: string
  private readonly now: () => number

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
    const http = createServer((_req, res) => {
      res.writeHead(404)
      res.end()
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
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.relayTimer) clearTimeout(this.relayTimer)
    this.relayTimer = null
    this.relaySocket?.close()
    this.relaySocket = null
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
    const relay = this.host.relayUrl()
    return {
      v: 1,
      pcId: this.host.pcId,
      name: this.host.pcName.slice(0, 60),
      host: this.advertiseHost,
      port: this.port,
      secret,
      ...(relay ? { relay } : {})
    }
  }

  status(): PhoneStatus {
    const inviteExpiresAt = this.invite && this.invite.expiresAt > this.now() ? this.invite.expiresAt : null
    return {
      listening: Boolean(this.http),
      host: this.advertiseHost,
      port: this.port,
      relay: this.host.relayUrl(),
      pcName: this.host.pcName,
      devices: this.host.devices(),
      inviteExpiresAt
    }
  }

  revoke(id: string): void {
    this.host.revokeDevice(id)
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
    socket.on("message", (data) => this.onRelay(data.toString()))
    socket.on("close", () => {
      if (this.relaySocket !== socket) return
      this.relaySocket = null
      if (!this.host.relayUrl() || !this.http) return
      this.relayTimer = setTimeout(() => this.reconnectRelay(), 3000)
    })
    socket.on("error", () => socket.close())
  }

  publishTask(task: PhoneTask): void {
    this.broadcast({ type: "task", task })
  }

  publishDelete(id: string): void {
    this.broadcast({ type: "task.deleted", id })
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

  private onRelay(text: string): void {
    let value: { op?: string; from?: string; body?: string }
    try {
      value = JSON.parse(text) as typeof value
    } catch {
      return
    }
    if (value.op !== "deliver" || typeof value.body !== "string" || typeof value.from !== "string") return
    let conn = this.relayConns.get(value.from)
    if (!conn) {
      conn = this.blank(null, value.from)
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
      if (frame.mode === "pair") this.onPair(conn, frame)
      else this.onSession(conn, frame)
    } catch (err) {
      const message = safeError(err)
      if (conn.key && conn.connId) this.send(conn, conn.key, "session", { type: "error", error: message })
      else this.fail(conn, frame.mode === "pair" ? 4001 : 4003)
    }
  }

  private onPair(conn: Conn, frame: ReturnType<typeof parseFrame>): void {
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
    this.send(conn, key, "pair", { type: "paired", token, deviceId, pcName: this.host.pcName })
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
      if (message.type === "task.stopAll") {
        this.host.stopAll()
        this.reply(conn, req, { ok: true })
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
      }
    } catch (err) {
      this.reply(conn, req, { ok: false, error: safeError(err) })
    }
  }

  private reply(conn: Conn, req: string, body: { ok: true; started?: string[]; errors?: { id: string; error: string }[]; task?: PhoneTask; health?: import("../shared/types").StoreHealth[] } | { ok: false; error: string }): void {
    if (!conn.key) return
    this.send(conn, conn.key, "session", body.ok
      ? { type: "result", req, ok: true, started: body.started, errors: body.errors, task: body.task, health: body.health }
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
    if (conn.rid && this.relaySocket && this.relaySocket.readyState === WebSocket.OPEN) {
      this.relaySocket.send(JSON.stringify({ op: "send", pc: this.host.pcId, to: conn.rid, body: frame }))
    }
  }

  private fail(conn: Conn, code: number): void {
    this.conns.delete(conn)
    if (conn.rid) this.relayConns.delete(conn.rid)
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) conn.ws.close(code)
  }
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Request failed."
  return message.replace(/\s+/g, " ").slice(0, 240)
}
