import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import QRCode from "qrcode"
import { afterEach, describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { PhoneSession } from "../src/phone/client"
import { RelayServer } from "../src/phone/relay"
import {
  INVITE_TTL_MS,
  EMPTY_ALERTS,
  EMPTY_ANALYTICS,
  EMPTY_KEEPER,
  EMPTY_UPDATES,
  encodePairingPayload,
  maskUsername,
  openFrame,
  pairKey,
  parseFrame,
  parsePairingPayload,
  projectAccount,
  projectProfile,
  projectProxyGroup,
  projectTask,
  randomSecret,
  seal,
  type PairingPayload,
  type PhoneSnapshot
} from "../src/phone/protocol"
import { PhoneServer, type PhoneHost } from "../src/phone/server"
import type { PublicAccount, PublicProfile, PublicTask } from "../src/shared/types"

const PAN = "4242424242424242"
const CVV = "9991"
const PASSWORD = "correct-horse-battery"
const PROXY_PASSWORD = "proxy-secret-value"
const EMAIL = "ada@example.com"
const STREET = "1 Secret Street"
const PC_ID = "11111111-1111-4111-8111-111111111111"

const address = {
  firstName: "Ada",
  lastName: "Lovelace",
  line1: STREET,
  line2: "",
  city: "New York",
  state: "NY",
  zip: "10001",
  country: "US" as const
}

const profile: PublicProfile = {
  id: "p1",
  name: "Home",
  email: EMAIL,
  phone: "2125550100",
  shipping: address,
  billing: address,
  cardName: "Ada Lovelace",
  last4: "4242",
  expMonth: "12",
  expYear: "2030"
}

const account: PublicAccount = {
  id: "a1",
  store: "target",
  label: "Main",
  username: EMAIL,
  hasPassword: true,
  hasSession: true,
  proxyGroupId: null,
  sessionState: "saved",
  lastWarmAt: null
}

function task(partial: Partial<PublicTask> = {}): PublicTask {
  return {
    id: partial.id ?? "t1",
    store: "target",
    sku: partial.sku ?? "88897904",
    quantity: 1,
    profileId: "p1",
    accountId: "a1",
    proxyGroupId: null,
    confirmPurchase: partial.confirmPurchase ?? true,
    testMode: partial.testMode === true,
    group: partial.group ?? "",
    status: "idle",
    detail: partial.detail ?? "",
    logs: partial.logs ?? [],
    createdAt: 1,
    ...partial,
    monitorProxyGroupId: partial.monitorProxyGroupId ?? null
  }
}

function memoryHost() {
  const tasks: PublicTask[] = []
  const devices: { id: string; name: string; token: string }[] = []
  const started: string[] = []
  const stopped: string[] = []
  let relay = ""
  let stopAll = 0
  const host: PhoneHost = {
    pcId: PC_ID,
    pcName: "Test PC",
    relayUrl: () => relay,
    snapshot: () => ({
      pcName: "Test PC",
      tasks: tasks.map((item) => projectTask(item, [profile], [account], [{ id: "g1", name: "Home proxies" }])),
      profiles: [projectProfile(profile)],
      accounts: [projectAccount(account)],
      proxyGroups: [projectProxyGroup({ id: "g1", name: "Home proxies", proxies: [{ password: PROXY_PASSWORD }] })],
      stores: [{ id: "target", name: "Target", skuHint: "TCIN", implemented: true }],
      testMode: false,
      clearCartAfterTest: false,
      alerts: EMPTY_ALERTS,
      schedules: [],
      analytics: EMPTY_ANALYTICS,
      updates: EMPTY_UPDATES,
      keeper: EMPTY_KEEPER
    }),
    saveTask(draft) {
      const next = task({ ...draft, id: draft.id ?? `t${tasks.length + 1}`, detail: "" })
      const index = tasks.findIndex((item) => item.id === next.id)
      if (index >= 0) tasks[index] = next
      else tasks.unshift(next)
      return projectTask(next, [profile], [account], [])
    },
    deleteTask(id) {
      const index = tasks.findIndex((item) => item.id === id)
      if (index < 0) throw new Error("Task not found.")
      tasks.splice(index, 1)
    },
    start(id, options) {
      const found = tasks.find((item) => item.id === id)
      if (!found) throw new Error("Task not found.")
      if (!options?.test && !found.testMode && !found.confirmPurchase) throw new Error("Confirm that this task may place a real shipping order before starting it.")
      started.push(id)
    },
    async checkHealth() {
      return []
    },
    stop(id) {
      stopped.push(id)
    },
    startAll() {
      const errors: { id: string; error: string }[] = []
      const ids: string[] = []
      for (const item of tasks) {
        try {
          this.start(item.id)
          ids.push(item.id)
        } catch (err) {
          errors.push({ id: item.id, error: err instanceof Error ? err.message : "failed" })
        }
      }
      return { started: ids, errors }
    },
    stopAll() {
      stopAll += 1
    },
    devices: () => devices.map(({ id, name }) => ({ id, name, createdAt: 1, lastSeenAt: 1 })),
    deviceTokens: () => devices.map((device) => ({ ...device })),
    saveDevice(device) {
      devices.push(device)
    },
    revokeDevice(id) {
      const index = devices.findIndex((device) => device.id === id)
      if (index < 0) throw new Error("That phone is not paired.")
      devices.splice(index, 1)
    },
    touchDevice() {}
  }
  return {
    host,
    tasks,
    started,
    stopped,
    setRelay(url: string) {
      relay = url
    },
    stopAllCount: () => stopAll
  }
}

describe("phone protocol", () => {
  const running: { stop: () => Promise<void> }[] = []

  afterEach(async () => {
    while (running.length) await running.pop()?.stop()
  })

  it("masks profiles, accounts, and proxy groups", () => {
    const view = JSON.stringify({
      profile: projectProfile(profile),
      account: projectAccount(account),
      proxy: projectProxyGroup({ id: "g1", name: "Home proxies", proxies: [{ password: PROXY_PASSWORD, username: "user" }] }),
      task: projectTask(task({ detail: `card ${PAN} cvv ${CVV}`, logs: [{ ts: 1, level: "info", message: "watching" }] }), [profile], [account], [])
    })
    expect(view).not.toContain(PAN)
    expect(view).not.toContain(CVV)
    expect(view).not.toContain(PASSWORD)
    expect(view).not.toContain(PROXY_PASSWORD)
    expect(view).toContain(EMAIL)
    expect(view).toContain(STREET)
    expect(view).toContain("[card]")
    expect(view).toContain("4242")
    expect(view).toContain("a***@example.com")
    expect(view).not.toContain(PASSWORD)
    expect(maskUsername("ada@example.com")).toBe("a***@example.com")
  })

  it("rejects a replayed or tampered frame", () => {
    const key = pairKey(randomSecret())
    const text = seal(key, { type: "pair", deviceName: "Pixel" }, { mode: "pair", pcId: PC_ID })
    const seen = new Set<string>()
    const frame = parseFrame(text)
    expect(openFrame(key, frame, Date.now(), seen)).toMatchObject({ type: "pair", deviceName: "Pixel" })
    expect(() => openFrame(key, frame, Date.now(), seen)).toThrow(/replay/i)
    expect(() => openFrame(key, { ...frame, c: `AAAA${frame.c.slice(4)}` }, Date.now(), new Set())).toThrow()
  })

  it("pairs over the LAN socket, controls tasks, and revokes the phone", async () => {
    const mem = memoryHost()
    const server = new PhoneServer(mem.host, { bindHost: "127.0.0.1", advertiseHost: "127.0.0.1", port: 0 })
    await server.start()
    const session = new PhoneSession()
    running.push({ stop: async () => { session.close(); await server.stop() } })
    const payload = server.createInvite()
    expect(parsePairingPayload(encodePairingPayload(payload)).pcId).toBe(PC_ID)
    const qr = await QRCode.toDataURL(encodePairingPayload(payload), { margin: 1, width: 128 })
    expect(qr.startsWith("data:image/png")).toBe(true)

    let snap: PhoneSnapshot | null = null
    let notice = ""
    session.onSnapshot((next) => { snap = next })
    session.onNotice((next) => { notice = `${next.kind}:${next.detail}` })
    const link = await session.pair(payload, "Pixel", { routes: ["direct"], directTimeoutMs: 1000 })
    expect(link.pcName).toBe("Test PC")
    expect(server.status().devices.map((device) => device.name)).toEqual(["Pixel"])
    expect(JSON.stringify(snap)).not.toContain(PAN)
    expect(JSON.stringify(snap)).not.toContain(PASSWORD)
    expect(JSON.stringify(snap)).not.toContain(PROXY_PASSWORD)
    expect(JSON.stringify(snap)).not.toContain(CVV)

    const saved = await session.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 2,
      profileId: "p1",
      accountId: "a1",
      proxyGroupId: null,
      confirmPurchase: true
    })
    expect(saved.ok).toBe(true)
    expect(saved.task?.quantity).toBe(2)
    expect(JSON.stringify(saved.task)).not.toContain(EMAIL)
    const started = await session.start(saved.task!.id)
    expect(started.ok).toBe(true)
    expect(mem.started).toEqual([saved.task!.id])
    await session.stop(saved.task!.id)
    expect(mem.stopped).toEqual([saved.task!.id])

    mem.tasks.push(task({ id: "locked", confirmPurchase: false }))
    const all = await session.startAll()
    expect(all.started).toContain(saved.task!.id)
    expect(all.errors?.some((item) => item.id === "locked")).toBe(true)
    await session.stopAll()
    expect(mem.stopAllCount()).toBe(1)

    server.publishNotice({ kind: "paused", storeName: "Target", sku: "88897904", profileName: "Home", detail: `robot ${PAN}`, ts: Date.now() })
    await waitFor(() => notice.includes("paused"))
    expect(notice).toContain("[card]")
    expect(notice).not.toContain(PAN)

    const again = new PhoneSession()
    await expect(again.pair(payload, "Other", { routes: ["direct"], directTimeoutMs: 800 })).rejects.toThrow()
    again.close()

    server.revoke(link.deviceId)
    await waitFor(() => session.saved() === null)
    expect(server.status().devices).toEqual([])
  })

  it("expires a pairing secret and refuses it", async () => {
    let clock = Date.now()
    const server = new PhoneServer(memoryHost().host, {
      bindHost: "127.0.0.1",
      advertiseHost: "127.0.0.1",
      port: 0,
      now: () => clock
    })
    await server.start()
    const session = new PhoneSession()
    running.push({ stop: async () => { session.close(); await server.stop() } })
    const payload = server.createInvite()
    clock += INVITE_TTL_MS + 1000
    await expect(session.pair(payload, "Pixel", { routes: ["direct"], directTimeoutMs: 800 })).rejects.toThrow()
  })

  it("pairs through the relay without putting task text on the relay", async () => {
    const relay = new RelayServer(0, "127.0.0.1")
    await relay.start()
    const mem = memoryHost()
    mem.setRelay(relay.url)
    const server = new PhoneServer(mem.host, { bindHost: "127.0.0.1", advertiseHost: "127.0.0.1", port: 0 })
    await server.start()
    const session = new PhoneSession()
    running.push({
      stop: async () => {
        session.close()
        await server.stop()
        await relay.close()
      }
    })
    await waitFor(() => relay.seen.some((line) => line.includes("\"role\":\"pc\"")))
    const payload = server.createInvite()
    expect(payload.relay).toBe(relay.url)
    const sku = "SENTINEL-SKU-do-not-leak-9f3a7c"
    const seenTasks: string[] = []
    session.onTask((item) => seenTasks.push(item.sku))
    await session.pair(payload, "Away", { routes: ["relay"], directTimeoutMs: 300 })
    await session.saveTask({
      store: "target",
      sku,
      quantity: 1,
      profileId: "p1",
      accountId: "a1",
      proxyGroupId: "g1",
      confirmPurchase: false
    })
    await waitFor(() => seenTasks.includes(sku))
    const raw = relay.seen.join("\n")
    expect(raw).not.toContain(sku)
    expect(raw).not.toContain(PAN)
    expect(raw).not.toContain(PASSWORD)
    expect(raw).not.toContain(PROXY_PASSWORD)
    expect(raw).not.toContain(payload.secret)
  })

  it("stores the phone token encrypted", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-phone-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const token = randomSecret()
    db.saveDevice({ id: "dev-1", name: "Pixel", token })
    const raw = readFileSync(join(dir, "tcgaio.json"), "utf8")
    expect(raw).not.toContain(token)
    expect(raw).toContain("aes:")
    expect(db.listDevices().map((device) => device.name)).toEqual(["Pixel"])
    expect(JSON.stringify(db.listDevices())).not.toContain(token)
    expect(db.deviceTokens()[0]?.token).toBe(token)
    db.revokeDevice("dev-1")
    expect(db.listDevices()).toEqual([])
  })

  it("rejects a pairing payload that is not a TCGAIO code", () => {
    expect(() => parsePairingPayload("https://example.com")).toThrow(/pairing code/i)
    const payload: PairingPayload = {
      v: 1,
      pcId: PC_ID,
      name: "PC",
      host: "10.0.0.8",
      port: 47321,
      secret: randomSecret()
    }
    expect(parsePairingPayload(encodePairingPayload(payload)).host).toBe("10.0.0.8")
  })
})

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now()
  while (!ready()) {
    if (Date.now() - start > 2000) throw new Error("Timed out waiting for the phone session.")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("hosted relay resume (0.2.36)", () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
  it("a restarted PC rejoins its saved relay without a new invite, and an away-from-home phone falls back to it", async () => {
    const { listenLicenseApi, OWNER_EMAIL } = await import("../license-server/server")
    const { provisionHostedRelay, mintRelayDevice } = await import("../src/phone/hosted-relay")
    const { fingerprintHash } = await import("../src/shared/license-proof")
    const { PC_AWAY_MESSAGE } = await import("../src/phone/client")
    process.env.RELAY_QUIET = "1"
    const dir = mkdtempSync(join(tmpdir(), "zzz-resume-"))
    const license = await listenLicenseApi({ dbPath: join(dir, "license.sqlite"), adminHtml: "<p>ok</p>", ownerSetupToken: "setup-token-value", ownerPassword: "owner-password", host: "127.0.0.1" })
    const login = await fetch(`${license.url}/v1/account/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: OWNER_EMAIL, password: "owner-password", fingerprint: fingerprintHash(["resume-pc"]) }) })
    const sessionToken = String(((await login.json()) as { token: string }).token)

    const mem = memoryHost()
    let saved: { channel: string; token: string } | null = null
    let provisioned = 0
    const host: PhoneHost = {
      ...mem.host,
      canResumeRelay: () => Boolean(saved),
      async provisionRelay() {
        provisioned += 1
        const hosted = await provisionHostedRelay({ licenseUrl: license.url, sessionToken, saved })
        saved = { channel: hosted.channel, token: hosted.pcToken }
        return hosted
      },
      issueRelayDevice: (deviceId: string) => mintRelayDevice({ licenseUrl: license.url, sessionToken, deviceId })
    }
    const servers: PhoneServer[] = []
    const sessions: PhoneSession[] = []
    cleanup.push(async () => {
      for (const item of sessions) item.close()
        for (const item of servers) await item.stop()
        await license.close()
    })

    // First run: the person pairs from the QR code (this is the only path that used to join the relay).
    const first = new PhoneServer(host, { bindHost: "127.0.0.1", advertiseHost: "127.0.0.1", port: 0 })
    servers.push(first)
    await first.start()
    await first.prepareRelay()
    const pairing = new PhoneSession()
    sessions.push(pairing)
    const link = await pairing.pair(first.createInvite(), "Pixel", { routes: ["relay"], directTimeoutMs: 500 })
    expect(link.relayChannel).toBe(saved!.channel)
    pairing.close()
    await first.stop()

    // Away from home: the LAN address is unreachable (TEST-NET), so direct times out and the relay is used.
    const away = { ...link, host: "203.0.113.1", port: 47321 }
    const phone = new PhoneSession(away)
    sessions.push(phone)
    const started = Date.now()
    await expect(phone.connect({ directTimeoutMs: 800 })).rejects.toThrow(PC_AWAY_MESSAGE)
    expect(Date.now() - started).toBeLessThan(4000)

    // PC restarts. Nobody opens the pairing screen; it rejoins the saved channel on its own.
    const before = provisioned
    const second = new PhoneServer(host, { bindHost: "127.0.0.1", advertiseHost: "127.0.0.1", port: 0 })
    servers.push(second)
    await second.start()
    await waitFor(() => provisioned > before)
    let snapshot: Awaited<ReturnType<PhoneSession["connect"]>> | null = null
    for (let attempt = 0; attempt < 20 && !snapshot; attempt += 1) {
      snapshot = await phone.connect({ directTimeoutMs: 300 }).catch(() => null)
      if (!snapshot) await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(snapshot?.pcName).toBe("Test PC")
    const result = await phone.saveTask({ store: "target", sku: "RELAY-RESUME-1", quantity: 1, profileId: "p1", accountId: "a1", proxyGroupId: "g1", confirmPurchase: false })
    expect(result.ok).toBe(true)

    // Live presence: PC goes away -> phone goes offline at once; PC comes back -> phone is online again without reconnecting.
    const states: boolean[] = []
    phone.onOnline((online) => states.push(online))
    await second.stop()
    await waitFor(() => states.includes(false))
    const third = new PhoneServer(host, { bindHost: "127.0.0.1", advertiseHost: "127.0.0.1", port: 0 })
    servers.push(third)
    await third.start()
    await waitFor(() => states[states.length - 1] === true)
  }, 30_000)
})
