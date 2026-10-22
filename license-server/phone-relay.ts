import { createHash, randomBytes } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { DatabaseSync } from "node:sqlite"
import { WebSocket, WebSocketServer } from "ws"

export const RELAY_INVITE_MS = 3 * 60 * 1000
const MAX_SOCKETS = 400
const MAX_PHONES = 20

export function migratePhoneRelay(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS phone_channels (
      user_id TEXT PRIMARY KEY,
      channel TEXT NOT NULL UNIQUE,
      pc_token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phone_relay_invites (
      token_hash TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phone_relay_devices (
      token_hash TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
}

export function provisionPhoneChannel(db: DatabaseSync, userId: string, rotate: boolean, now: number): { channel: string; pcToken?: string } {
  const row = db.prepare("SELECT channel FROM phone_channels WHERE user_id = ?").get(userId) as { channel: string } | undefined
  if (row && !rotate) return { channel: row.channel }
  if (row) dropChannel(db, row.channel)
  const channel = randomBytes(16).toString("base64url")
  const pcToken = randomBytes(32).toString("base64url")
  db.prepare("INSERT INTO phone_channels (user_id, channel, pc_token_hash, created_at) VALUES (?, ?, ?, ?)").run(userId, channel, sha(pcToken), now)
  return { channel, pcToken }
}

export function mintPhoneInvite(db: DatabaseSync, userId: string, now: number): { channel: string; token: string; expiresAt: number } | null {
  const row = db.prepare("SELECT channel FROM phone_channels WHERE user_id = ?").get(userId) as { channel: string } | undefined
  if (!row) return null
  db.prepare("DELETE FROM phone_relay_invites WHERE channel = ? AND expires_at <= ?").run(row.channel, now)
  const invite = randomBytes(32).toString("base64url")
  const expiresAt = now + RELAY_INVITE_MS
  db.prepare("INSERT INTO phone_relay_invites (token_hash, channel, expires_at) VALUES (?, ?, ?)").run(sha(invite), row.channel, expiresAt)
  return { channel: row.channel, token: invite, expiresAt }
}

export function mintPhoneDevice(db: DatabaseSync, userId: string, deviceId: string, now: number): { channel: string; token: string } | null {
  const clean = deviceId.trim()
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(clean)) return null
  const row = db.prepare("SELECT channel FROM phone_channels WHERE user_id = ?").get(userId) as { channel: string } | undefined
  if (!row) return null
  const others = db.prepare("SELECT COUNT(DISTINCT device_id) AS count FROM phone_relay_devices WHERE channel = ? AND device_id != ?").get(row.channel, clean) as { count: number }
  if (others.count >= MAX_PHONES) return null
  db.prepare("DELETE FROM phone_relay_devices WHERE channel = ? AND device_id = ?").run(row.channel, clean)
  const deviceToken = randomBytes(32).toString("base64url")
  db.prepare("INSERT INTO phone_relay_devices (token_hash, channel, device_id, created_at) VALUES (?, ?, ?, ?)").run(sha(deviceToken), row.channel, clean, now)
  return { channel: row.channel, token: deviceToken }
}

export function revokePhoneDevice(db: DatabaseSync, userId: string, deviceId: string): { channel: string } | null {
  const row = db.prepare("SELECT channel FROM phone_channels WHERE user_id = ?").get(userId) as { channel: string } | undefined
  if (!row) return null
  db.prepare("DELETE FROM phone_relay_devices WHERE channel = ? AND device_id = ?").run(row.channel, deviceId.trim())
  return { channel: row.channel }
}

export interface RelayJoin {
  role: "pc" | "phone"
  channel: string
  deviceId: string | null
}

export function authorizeRelayJoin(db: DatabaseSync, input: { role?: string; channel?: string; token?: string }, now: number): RelayJoin | null {
  if ((input.role !== "pc" && input.role !== "phone") || typeof input.channel !== "string" || typeof input.token !== "string") return null
  if (input.channel.length > 80 || input.token.length > 200) return null
  const hash = sha(input.token)
  if (input.role === "pc") {
    const row = db.prepare("SELECT channel FROM phone_channels WHERE channel = ? AND pc_token_hash = ?").get(input.channel, hash) as { channel: string } | undefined
    return row ? { role: "pc", channel: row.channel, deviceId: null } : null
  }
  const device = db.prepare("SELECT channel, device_id FROM phone_relay_devices WHERE channel = ? AND token_hash = ?").get(input.channel, hash) as { channel: string; device_id: string } | undefined
  if (device) return { role: "phone", channel: device.channel, deviceId: device.device_id }
  const invite = db.prepare("SELECT expires_at FROM phone_relay_invites WHERE channel = ? AND token_hash = ?").get(input.channel, hash) as { expires_at: number } | undefined
  if (!invite || invite.expires_at <= now) return null
  db.prepare("DELETE FROM phone_relay_invites WHERE token_hash = ?").run(hash)
  return { role: "phone", channel: input.channel, deviceId: null }
}

interface Peer {
  role: "pc" | "phone"
  channel: string
  id: string
  deviceId: string | null
}

/**
 * Routes opaque frames for one account channel.
 * The desktop connects outbound. Frames stay encrypted by the phone protocol.
 */
export class PhoneRelayHub {
  private wss: WebSocketServer | null = null
  private peers = new Map<WebSocket, Peer>()
  private seq = 0
  private sockets = 0

  constructor(private readonly authorize: (input: { role?: string; channel?: string; token?: string }) => RelayJoin | null) {}

  attach(server: { on(event: "upgrade", listener: (req: IncomingMessage, socket: unknown, head: Buffer) => void): void }): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256_000, perMessageDeflate: false })
    this.wss = wss
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0]
      const raw = socket as { write(chunk: string): void; destroy(): void }
      if (path !== "/v1/phone/relay") {
        raw.destroy()
        return
      }
      if (this.sockets >= MAX_SOCKETS) {
        raw.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
        raw.destroy()
        return
      }
      wss.handleUpgrade(req, socket as never, head, (ws) => {
        this.sockets += 1
        ws.on("message", (data) => this.onMessage(ws, data.toString()))
        ws.on("close", () => {
          this.peers.delete(ws)
          this.sockets = Math.max(0, this.sockets - 1)
        })
        ws.on("error", () => ws.close())
      })
    })
  }

  dropDevice(channel: string, deviceId: string): void {
    for (const [socket, peer] of this.peers) {
      if (peer.channel === channel && peer.role === "phone" && peer.deviceId === deviceId) socket.close(4003, "revoked")
    }
  }

  close(): void {
    for (const socket of this.peers.keys()) socket.close()
    this.peers.clear()
    this.wss?.close()
    this.wss = null
    this.sockets = 0
  }

  private onMessage(socket: WebSocket, text: string): void {
    let value: { op?: string; role?: string; channel?: string; token?: string; to?: string; body?: string }
    try {
      value = JSON.parse(text) as typeof value
    } catch {
      socket.close(4000, "bad frame")
      return
    }
    if (value.op === "join") {
      const join = this.authorize({ role: value.role, channel: value.channel, token: value.token })
      if (!join) {
        socket.close(4003, "unauthorized")
        return
      }
      if (join.role === "phone") {
        const phones = [...this.peers.values()].filter((peer) => peer.channel === join.channel && peer.role === "phone").length
        if (phones >= MAX_PHONES) {
          socket.close(4003, "full")
          return
        }
      }
      if (join.role === "pc") {
        for (const [other, peer] of this.peers) {
          if (peer.role === "pc" && peer.channel === join.channel) other.close(4001, "replaced")
        }
      }
      this.seq += 1
      const id = `r${this.seq.toString(36)}`
      this.peers.set(socket, { role: join.role, channel: join.channel, id, deviceId: join.deviceId })
      socket.send(JSON.stringify({ op: "joined", id }))
      return
    }
    const peer = this.peers.get(socket)
    if (!peer || value.op !== "send" || typeof value.body !== "string" || value.body.length > 256_000) {
      socket.close(4000, "not joined")
      return
    }
    if (peer.role === "phone") {
      this.deliver(peer.channel, "pc", undefined, value.body, peer.id)
      return
    }
    if (typeof value.to !== "string" || !value.to) return
    this.deliver(peer.channel, "phone", value.to, value.body, peer.id)
  }

  private deliver(channel: string, role: Peer["role"], id: string | undefined, body: string, from: string): void {
    const frame = JSON.stringify({ op: "deliver", from, body })
    for (const [socket, peer] of this.peers) {
      if (peer.channel !== channel || peer.role !== role) continue
      if (id && peer.id !== id) continue
      if (socket.readyState === WebSocket.OPEN) socket.send(frame)
    }
  }
}

function dropChannel(db: DatabaseSync, channel: string): void {
  db.prepare("DELETE FROM phone_relay_invites WHERE channel = ?").run(channel)
  db.prepare("DELETE FROM phone_relay_devices WHERE channel = ?").run(channel)
  db.prepare("DELETE FROM phone_channels WHERE channel = ?").run(channel)
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
