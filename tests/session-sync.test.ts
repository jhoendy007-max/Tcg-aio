import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { alertsFor, vaultFlag, vaultScan } from "../src/engine/vault"
import { PhoneSession } from "../src/phone/client"
import { createPhoneHost } from "../src/phone/backend"
import { openFrame, pairKey as nodePairKey, parseFrame, randomSecret, seal, sessionKey as nodeSessionKey } from "../src/phone/protocol"
import { PhoneServer } from "../src/phone/server"
import type { PublicAccount, VaultLink } from "../src/shared/types"

interface PolicyModule {
  domainAllowed(store: string, domain: string): boolean
  selectCookies(store: string, cookies: { name?: string; value?: string; domain?: string }[]): { name: string }[]
  selectStorage(store: string, entries: { key?: string; value?: string }[]): { key: string; value: string }[]
  cookieHeader(store: string, cookies: unknown[], storage: unknown[]): string
  pairsFromHeader(header: string): { name: string; value: string }[]
}

interface WireModule {
  pairKey(secret: string): Promise<Uint8Array>
  sessionKey(token: string): Promise<Uint8Array>
  seal(key: Uint8Array, message: unknown, header: { mode: "pair" | "session"; pcId: string }): Promise<string>
  openFrame(key: Uint8Array, frame: ReturnType<typeof parseFrame>, now?: number, seen?: Set<string>): Promise<{ type: string }>
}

interface PackModule {
  extensionZip(dir?: string): Buffer
  extensionCrx(zip: Buffer): Buffer
  zipNames(zip: Buffer): string[]
}

async function load<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>
}

const policy = await load<PolicyModule>(pathToFileURL(join(process.cwd(), "extension/policy.mjs")).href)
const wire = await load<WireModule>(pathToFileURL(join(process.cwd(), "extension/wire.mjs")).href)
const pack = await load<PackModule>(pathToFileURL(join(process.cwd(), "scripts/pack-extension.mjs")).href)

const PC = "22222222-2222-4222-8222-222222222222"
const TOKEN = "sync-token-9f3c1a7b"
const COOKIE = `accessToken=${TOKEN}; visitorId=visitor-9`

function link(partial: Partial<VaultLink> = {}): VaultLink {
  return {
    accountId: "a1",
    deviceId: "d1",
    twoWay: false,
    linkedAt: 1,
    lastUsedAt: 1,
    expiresAt: null,
    loggedOut: false,
    alertedDay: "",
    ...partial
  }
}

function account(partial: Partial<PublicAccount> = {}): PublicAccount {
  return {
    id: "a1",
    store: "target",
    label: "Main",
    username: "ada@example.com",
    hasPassword: true,
    hasSession: true,
    proxyGroupId: null,
    sessionState: "saved",
    lastWarmAt: null,
    ...partial
  }
}

describe("session sync policy", () => {
  it("keeps only the linked store's cookies and allowlisted storage", () => {
    const cookies = [
      { name: "accessToken", value: "own", domain: ".target.com" },
      { name: "sid", value: "elsewhere", domain: ".example.com" },
      { name: "blank", value: "", domain: "www.target.com" }
    ]
    expect(policy.selectCookies("target", cookies).map((cookie) => cookie.name)).toEqual(["accessToken"])
    expect(policy.domainAllowed("walmart", "www.target.com")).toBe(false)
    expect(policy.domainAllowed("bandai", "www.p-bandai.com")).toBe(true)
    expect(policy.selectStorage("target", [{ key: "accessToken", value: "t" }, { key: "cart", value: "no" }])).toEqual([{ key: "accessToken", value: "t" }])
    expect(policy.selectStorage("amazon", [{ key: "session-id", value: "no" }])).toEqual([])
    const header = policy.cookieHeader("target", cookies, [{ key: "refreshToken", value: "r" }])
    expect(header).toContain("accessToken=own")
    expect(header).toContain("refreshToken=r")
    expect(header).not.toContain("elsewhere")
    expect(policy.cookieHeader("target", [{ name: "a", value: "x".repeat(9000), domain: "target.com" }], []).length).toBe(8192)
    expect(policy.pairsFromHeader("accessToken=own; forged name=no; =missing").map((pair) => pair.name)).toEqual(["accessToken"])
  })

  it("limits the manifest to the store sites", () => {
    const manifest = JSON.parse(readFileSync(join("extension", "manifest.json"), "utf8"))
    const sites = ["target.com", "walmart.com", "bestbuy.com", "pokemoncenter.com", "amazon.com", "crunchyroll.com", "p-bandai.com", "gamestop.com", "barnesandnoble.com", "costco.com", "samsclub.com", "tcgplayer.com"]
    expect(manifest.permissions).toEqual(["cookies", "storage", "alarms", "scripting"])
    expect(JSON.stringify(manifest.host_permissions)).not.toContain("all_urls")
    for (const pattern of manifest.host_permissions) {
      const host = new URL(pattern.replace("*.", "")).hostname
      expect(sites.some((site) => host === site || host.endsWith(`.${site}`))).toBe(true)
    }
    const background = readFileSync(join("extension", "background.js"), "utf8")
    expect(background).toContain("domain: site")
    expect(background).not.toContain("chrome.cookies.getAll({})")
    expect(background).not.toContain("<all_urls>")
  })

  it("packs a loadable zip and a crx around the same files", () => {
    const zip = pack.extensionZip()
    expect(pack.zipNames(zip)).toEqual(["manifest.json", "background.js", "popup.html", "popup.js", "popup.css", "policy.mjs", "wire.mjs", "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png"])
    expect(zip.includes(Buffer.from("PRIVATE KEY"))).toBe(false)
    const crx = pack.extensionCrx(zip)
    expect(crx.subarray(0, 4).toString()).toBe("Cr24")
    expect(crx.readUInt32LE(4)).toBe(3)
    const zipAt = 12 + crx.readUInt32LE(8)
    expect(pack.zipNames(crx.subarray(zipAt))).toEqual(pack.zipNames(zip))
  })
})

describe("vault health", () => {
  const now = Date.parse("2026-10-17T12:00:00Z")
  const hour = 60 * 60 * 1000

  it("flags expiry and pages once per day", () => {
    expect(vaultFlag(link({ expiresAt: now + 48 * hour }), "saved", now)).toBe("ok")
    expect(vaultFlag(link({ expiresAt: now + 10 * hour }), "saved", now)).toBe("expiring")
    expect(vaultFlag(link({ expiresAt: now - 1000 }), "saved", now)).toBe("logged-out")
    expect(vaultFlag(link(), "expired", now)).toBe("logged-out")
    const expiring = link({ expiresAt: now + 10 * hour })
    expect(alertsFor([expiring], [account()], now, "2026-10-17")).toHaveLength(1)
    expect(alertsFor([{ ...expiring, alertedDay: "2026-10-17" }], [account()], now, "2026-10-17")).toHaveLength(0)
    expect(alertsFor([link()], [account({ sessionState: "missing", hasSession: false })], now, "2026-10-17")).toHaveLength(0)
    const plan = vaultScan([link({ expiresAt: now - 1000 })], [account()], now, "2026-10-17")
    expect(plan.expireIds).toEqual(["a1"])
    expect(plan.notices[0]?.loggedOut).toBe(true)
    expect(plan.notices[0]?.detail).not.toContain(TOKEN)
  })
})

describe("extension wire", () => {
  it("matches the desktop pairing cipher", async () => {
    const secret = randomSecret()
    const web = await wire.pairKey(secret)
    const node = nodePairKey(secret)
    expect(Buffer.from(web)).toEqual(Buffer.from(node))
    const token = randomSecret()
    expect(Buffer.from(await wire.sessionKey(token))).toEqual(Buffer.from(nodeSessionKey(token)))
    const text = await wire.seal(web, { type: "pair", deviceName: "Session Sync" }, { mode: "pair", pcId: PC })
    const seen = new Set<string>()
    expect(openFrame(node, parseFrame(text), Date.now(), seen)).toMatchObject({ type: "pair", deviceName: "Session Sync" })
    const back = seal(node, { type: "hello" }, { mode: "session", pcId: PC })
    expect(await wire.openFrame(web, parseFrame(back), Date.now(), new Set())).toMatchObject({ type: "hello" })
  })
})

describe("vault sync", () => {
  const running: PhoneServer[] = []

  afterEach(async () => {
    while (running.length) await running.pop()?.stop()
  })

  async function boot() {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-vault-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const saved = db.saveAccount({
      store: "target",
      label: "Main",
      username: "ada@example.com",
      password: "correct-horse",
      passwordAction: "replace",
      session: "",
      sessionAction: "keep"
    })
    const server = new PhoneServer(createPhoneHost(db, () => null), { bindHost: "127.0.0.1", advertiseHost: "127.0.0.1", port: 0 })
    await server.start()
    running.push(server)
    const session = new PhoneSession()
    const link = await session.pair(server.createInvite(), "Session Sync", { routes: ["direct"], directTimeoutMs: 1000 })
    return { db, server, session, saved, link, dir }
  }

  it("stores a linked browser session encrypted and keeps it out of the snapshot", async () => {
    const { db, session, saved, dir } = await boot()
    const early = await session.pushVault(saved.id, COOKIE, Date.now() + 86_400_000)
    expect(early.ok).toBe(false)
    expect(early.error).toMatch(/Link this account/i)
    let echoes = 0
    db.onSessionSaved(() => {
      echoes += 1
    })
    expect((await session.linkVault(saved.id, false)).ok).toBe(true)
    const expiresAt = Date.now() + 48 * 60 * 60 * 1000
    expect((await session.pushVault(saved.id, COOKIE, expiresAt)).ok).toBe(true)
    expect(echoes).toBe(0)
    expect(db.readAccount(saved.id).session?.accessToken).toBe(TOKEN)
    const listed = db.listVault()
    expect(listed[0]?.flag).toBe("ok")
    expect(JSON.stringify(listed)).not.toContain(TOKEN)
    const snap = JSON.stringify(await session.sync())
    expect(snap).not.toContain(TOKEN)
    expect(snap).not.toContain("visitor-9")
    const raw = readFileSync(join(dir, "tcgaio.json"), "utf8")
    expect(raw).not.toContain(TOKEN)
    expect(raw).not.toContain("visitor-9")
    expect(raw).toContain("aes:")
    const pulled = await session.pullVault(saved.id)
    expect(pulled.ok).toBe(false)
    expect(pulled.error).toMatch(/Two-way/i)
    expect((await session.unlinkVault(saved.id)).ok).toBe(true)
    const blocked = await session.pushVault(saved.id, COOKIE, expiresAt)
    expect(blocked.ok).toBe(false)
  }, 15000)

  it("pushes a refreshed session only to the browser that turned two-way on", async () => {
    const { db, server, session, saved } = await boot()
    const other = new PhoneSession()
    await other.pair(server.createInvite(), "Other phone", { routes: ["direct"], directTimeoutMs: 1000 })
    expect((await session.linkVault(saved.id, true)).ok).toBe(true)
    expect((await session.pushVault(saved.id, COOKIE, Date.now() + 48 * 60 * 60 * 1000)).ok).toBe(true)
    const pulled = await session.pullVault(saved.id)
    expect(pulled.ok).toBe(true)
    expect(pulled.cookie).toContain(TOKEN)
    let leaked = ""
    other.onVault((_id, cookie) => {
      leaked = cookie
    })
    const incoming = new Promise<string>((resolve) => session.onVault((_id, cookie) => resolve(cookie)))
    db.onSessionSaved((accountId) => {
      const cookie = db.readAccount(accountId).session?.cookie ?? ""
      if (cookie) server.pushVaultSession(accountId, cookie)
    })
    db.updateSession(saved.id, db.readAccount(saved.id).session!)
    expect(await incoming).toContain(TOKEN)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(leaked).toBe("")
    const deviceId = db.listDevices().find((device) => device.name === "Session Sync")?.id
    expect(deviceId).toBeTruthy()
    server.revoke(deviceId!)
    expect(db.vaultLinks()).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 30))
    await expect(session.pullVault(saved.id)).rejects.toThrow(/revoked|not connected/i)
  }, 15000)
})
