import { createServer, type Server as HttpServer } from "node:http"
import { WebSocketServer, type WebSocket } from "ws"

interface Peer {
  role: "pc" | "phone"
  pc: string
  id: string
}

/**
 * Forwards opaque frames between one desktop and its phones.
 * The body is encrypted by the desktop protocol. This process only routes.
 */
export class RelayServer {
  readonly seen: string[] = []
  port = 0
  private http: HttpServer | null = null
  private wss: WebSocketServer | null = null
  private peers = new Map<WebSocket, Peer>()
  private seq = 0

  constructor(
    private readonly bindPort = 0,
    private readonly host = "127.0.0.1"
  ) {}

  get url(): string {
    return `ws://${this.host === "0.0.0.0" ? "127.0.0.1" : this.host}:${this.port}`
  }

  start(): Promise<void> {
    const http = createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const wss = new WebSocketServer({ server: http, maxPayload: 256_000, perMessageDeflate: false })
    wss.on("connection", (socket) => {
      socket.on("message", (data) => this.onMessage(socket, data.toString()))
      socket.on("close", () => this.peers.delete(socket))
      socket.on("error", () => socket.close())
    })
    this.http = http
    this.wss = wss
    return new Promise((resolve, reject) => {
      http.once("error", reject)
      http.listen(this.bindPort, this.host, () => {
        const address = http.address()
        this.port = typeof address === "object" && address ? address.port : this.bindPort
        resolve()
      })
    })
  }

  close(): Promise<void> {
    for (const socket of this.peers.keys()) socket.close()
    this.peers.clear()
    this.wss?.close()
    const http = this.http
    this.http = null
    this.wss = null
    if (!http) return Promise.resolve()
    return new Promise((resolve) => http.close(() => resolve()))
  }

  private onMessage(socket: WebSocket, text: string): void {
    this.seen.push(text)
    let value: { op?: string; role?: string; pc?: string; to?: string; body?: string }
    try {
      value = JSON.parse(text) as typeof value
    } catch {
      socket.close(4000, "bad frame")
      return
    }
    if (value.op === "join") {
      if ((value.role !== "pc" && value.role !== "phone") || typeof value.pc !== "string" || !value.pc) {
        socket.close(4000, "bad join")
        return
      }
      if (value.role === "pc") {
        for (const [other, peer] of this.peers) {
          if (peer.role === "pc" && peer.pc === value.pc) other.close(4001, "replaced")
        }
      }
      this.seq += 1
      const id = `r${this.seq.toString(36)}`
      this.peers.set(socket, { role: value.role, pc: value.pc, id })
      socket.send(JSON.stringify({ op: "joined", id }))
      return
    }
    const peer = this.peers.get(socket)
    if (!peer || value.op !== "send" || typeof value.body !== "string" || value.pc !== peer.pc) {
      socket.close(4000, "not joined")
      return
    }
    if (peer.role === "phone") {
      this.deliver(peer.pc, "pc", undefined, value.body, peer.id)
      return
    }
    if (typeof value.to !== "string" || !value.to) return
    this.deliver(peer.pc, "phone", value.to, value.body, peer.id)
  }

  private deliver(pc: string, role: Peer["role"], id: string | undefined, body: string, from: string): void {
    const frame = JSON.stringify({ op: "deliver", from, body })
    for (const [socket, peer] of this.peers) {
      if (peer.pc !== pc || peer.role !== role) continue
      if (id && peer.id !== id) continue
      socket.send(frame)
    }
  }
}
