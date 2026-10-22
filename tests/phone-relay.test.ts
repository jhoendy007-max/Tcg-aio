import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { listenLicenseApi, OWNER_EMAIL } from "../license-server/server"
import { relaySocketUrl } from "../src/phone/hosted-relay"
import { fingerprintHash } from "../src/shared/license-proof"

const open: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  while (open.length) await open.pop()?.close()
})

describe("hosted phone relay", () => {
  it("provisions a channel with the account session and forwards only authenticated frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-relay-"))
    const server = await listenLicenseApi({
      dbPath: join(dir, "license.sqlite"),
      adminHtml: "<p>ok</p>",
      ownerSetupToken: "setup-token-value",
      ownerPassword: "owner-password",
      host: "127.0.0.1"
    })
    open.push(server)
    const fingerprint = fingerprintHash(["relay-pc"])
    const login = await post(server.url, "/v1/account/login", {
      email: OWNER_EMAIL,
      password: "owner-password",
      fingerprint
    })
    expect(login.status).toBe(200)
    const token = String(login.body.token)
    expect((await post(server.url, "/v1/phone/relay", { rotate: true })).status).toBe(401)
    const channel = await post(server.url, "/v1/phone/relay", { rotate: true }, token)
    expect(channel.status).toBe(200)
    const invite = await post(server.url, "/v1/phone/relay/invite", {}, token)
    expect(invite.status).toBe(200)
    const url = relaySocketUrl(server.url)
    expect(url.startsWith("ws://127.0.0.1:")).toBe(true)
    expect(url.endsWith("/v1/phone/relay")).toBe(true)

    const pc = await joinRelay(url, { op: "join", role: "pc", channel: channel.body.channel, token: channel.body.pcToken })
    const phone = await joinRelay(url, { op: "join", role: "phone", channel: invite.body.channel, token: invite.body.token })
    const delivered = waitFor(pc.socket, (frame) => frame.op === "deliver")
    phone.socket.send(JSON.stringify({ op: "send", body: "sealed-frame" }))
    const frame = await delivered
    expect(frame.body).toBe("sealed-frame")
    expect(JSON.stringify(frame)).not.toContain("sealed-frame-plain")

    const rejected = joinRelay(url, { op: "join", role: "phone", channel: invite.body.channel, token: invite.body.token })
    await expect(rejected).rejects.toThrow(/unauthorized|closed/i)

    const device = await post(server.url, "/v1/phone/relay/device", { deviceId: "phone-device-1" }, token)
    expect(device.status).toBe(200)
    const saved = await joinRelay(url, { op: "join", role: "phone", channel: device.body.channel, token: device.body.token })
    const revoked = await post(server.url, "/v1/phone/relay/revoke", { deviceId: "phone-device-1" }, token)
    expect(revoked.status).toBe(200)
    await closed(saved.socket)
    await expect(joinRelay(url, { op: "join", role: "phone", channel: device.body.channel, token: device.body.token })).rejects.toThrow(/unauthorized|closed/i)
    pc.socket.close()
    phone.socket.close()
  })
})

async function post(base: string, path: string, body: unknown, token = ""): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

function joinRelay(url: string, hello: Record<string, unknown>): Promise<{ socket: WebSocket; id: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error("The relay closed before join."))
    }, 4000)
    socket.on("error", () => undefined)
    socket.on("close", () => {
      clearTimeout(timer)
      reject(new Error("unauthorized closed"))
    })
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { op?: string; id?: string }
      if (frame.op === "joined" && frame.id) {
        clearTimeout(timer)
        socket.removeAllListeners("close")
        resolve({ socket, id: frame.id })
      }
    })
    socket.on("open", () => socket.send(JSON.stringify(hello)))
  })
}

function waitFor(socket: WebSocket, match: (frame: { op?: string; body?: string }) => boolean): Promise<{ op?: string; body?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The relay did not deliver a frame.")), 4000)
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { op?: string; body?: string }
      if (!match(frame)) return
      clearTimeout(timer)
      resolve(frame)
    })
  })
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve) => socket.once("close", () => resolve()))
}
