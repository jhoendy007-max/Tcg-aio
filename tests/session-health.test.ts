import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { applyBlockRates } from "../src/engine/health"
import { backoffDelay, isBlockStatus, jitterDelay, PoliteLimiter, STORE_GAP_MS } from "../src/engine/polite"
import { healthScore } from "../src/shared/consistency"
import { BENCH_AFTER, chooseSticky, noteBlock, noteScore } from "../src/engine/proxy-hygiene"
import { looksSignedOut, storeHome, storeSignInUrl, warmupDue } from "../src/engine/session-care"
import type { ProxyEndpoint, StoreId } from "../src/shared/types"

const proxies: ProxyEndpoint[] = [
  { id: "a", host: "10.0.0.1", port: 8000, username: "user", password: "secret-pass" },
  { id: "b", host: "10.0.0.2", port: 8000, username: "user", password: "secret-pass" }
]

describe("polite timing", () => {
  it("jitters inside the requested percent and backs off on block statuses", () => {
    expect(jitterDelay(1000, 20, 0)).toBe(800)
    expect(jitterDelay(1000, 20, 1)).toBe(1200)
    expect(backoffDelay(0, 3500)).toBe(0)
    expect(backoffDelay(1, 3500)).toBe(3500)
    expect(backoffDelay(3, 3500)).toBe(14000)
    expect(backoffDelay(9, 3500)).toBe(56000)
    expect(backoffDelay(9, 10_000)).toBe(120000)
    for (const status of [403, 412, 429, 435]) expect(isBlockStatus(status)).toBe(true)
    expect(isBlockStatus(200)).toBe(false)
    expect(STORE_GAP_MS.target).toBeGreaterThan(0)
    expect(STORE_GAP_MS.walmart).toBeGreaterThan(STORE_GAP_MS.target)
  })

  it("waits for the per-store gap before the next request", async () => {
    let now = 0
    const waits: number[] = []
    const limiter = new PoliteLimiter(() => now, async (ms) => {
      waits.push(ms)
      now += ms
    })
    const seen: number[] = []
    const http = limiter.wrap("target", "a", {
      async request() {
        seen.push(now)
        return { status: 429, headers: {}, body: "" }
      }
    }, () => undefined)
    await http.request({ method: "GET", url: "https://www.target.com/" })
    await http.request({ method: "GET", url: "https://www.target.com/" })
    expect(waits).toEqual([STORE_GAP_MS.target])
    expect(seen[1] - seen[0]).toBe(STORE_GAP_MS.target)
  })
})

describe("proxy hygiene", () => {
  it("keeps one proxy per account and benches it after repeated blocks", () => {
    const first = chooseSticky(proxies, [], [], "acct", "group", 0)
    expect(first.choice.proxy?.id).toBe("a")
    const again = chooseSticky(proxies, first.pins, [], "acct", "group", 0)
    expect(again.choice.proxy?.id).toBe("a")
    expect(again.choice.rotated).toBe(false)
    let scores = noteScore([], "a", 403, 0)
    scores = noteScore(scores, "a", 412, 0)
    scores = noteScore(scores, "a", 429, 1_000)
    expect(scores[0]?.streak).toBe(2)
    expect(scores[0]?.benchedUntil).toBe(0)
    expect(healthScore(scores[0])).toBe(0)
    scores = noteScore(scores, "a", 435, 1_000)
    expect(scores[0]?.streak).toBe(BENCH_AFTER)
    expect(scores[0]?.benchedUntil).toBeGreaterThan(1_000)
    const moved = chooseSticky(proxies, again.pins, scores, "acct", "group", 1_000)
    expect(moved.choice.proxy?.id).toBe("b")
    expect(moved.choice.rotated).toBe(true)
    expect(JSON.stringify({ pins: moved.pins, scores })).not.toContain("secret-pass")
    const tallies = noteBlock(noteBlock([], "walmart", true), "walmart", false)
    expect(tallies[0]).toMatchObject({ samples: 2, blocked: 1 })
  })

  it("records block rate on a health sample without sending a proxy password", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-hygiene-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const group = db.saveProxyGroup({ name: "Pool", text: "10.0.0.1:8000:user:secret-pass\n10.0.0.2:8000:user:secret-pass", network: "residential" })
    expect(group.network).toBe("residential")
    const choice = db.assignProxy("acct-1", group.id, group.proxies, 0)
    expect(choice.proxy?.id).toBe(group.proxies[0]?.id)
    db.noteTraffic("walmart", choice.proxy?.id, 412)
    db.noteTraffic("walmart", choice.proxy?.id, 412)
    db.noteTraffic("walmart", choice.proxy?.id, 412)
    const benched = db.assignProxy("acct-1", group.id, group.proxies, Date.now())
    expect(benched.proxy?.id).toBe(group.proxies[1]?.id)
    expect(benched.rotated).toBe(true)
    const report = db.recordHealth([
      { store: "walmart", storeName: "Walmart", proxy: "10.0.0.1:8000", status: 403, verdict: "challenge", detail: "HTTP 403", ms: 10, blockSamples: 0, blockCount: 0, blockRate: 0 }
    ], [group.proxies[0]])
    expect(report[0]?.blockCount).toBeGreaterThan(0)
    expect(report[0]?.detail).toContain("block rate")
    expect(JSON.stringify(db.proxyScores())).not.toContain("secret-pass")
    const edited = db.saveProxyGroup({ id: group.id, name: "Pool", text: "10.0.0.1:8000:user:secret-pass", network: "datacenter" })
    expect(edited.proxies[0]?.id).toBe(group.proxies[0]?.id)
    expect(edited.network).toBe("datacenter")
  })
})

describe("session care", () => {
  it("treats a sign-in page as expired and a normal homepage as still signed in", () => {
    expect(storeHome("target")).toBe("https://www.target.com/")
    expect(storeHome("amazon")).toBe("https://www.amazon.com/")
    expect(looksSignedOut("https://www.amazon.com/ap/signin?openid=1", "session-id=1")).toBe(true)
    expect(looksSignedOut("https://www.target.com/account/login", "accessToken=1")).toBe(true)
    expect(looksSignedOut("https://www.walmart.com/", "")).toBe(true)
    expect(looksSignedOut("https://www.bestbuy.com/", "at=token")).toBe(false)
    // Costco signs in on its own B2C host, Barnes & Noble on a Shopify page, Sam's on /login (0.2.46).
    expect(looksSignedOut("https://signin.costco.com/e0714dd4/B2C_1A_SSO_WCS_signup_signin_214/oauth2/v2.0/authorize?x=1", "a=1")).toBe(true)
    expect(looksSignedOut("https://www.costco.com/LogonForm", "a=1")).toBe(true)
    expect(looksSignedOut("https://shopify.com/authentication/67454337265/oauth/authorize?client_id=x", "a=1")).toBe(true)
    expect(looksSignedOut("https://www.samsclub.com/login", "a=1")).toBe(true)
    expect(looksSignedOut("https://www.costco.com/p/-/mega/4000200441", "a=1")).toBe(false)
    expect(storeSignInUrl("costco")).toBe("https://www.costco.com/LogonForm")
    expect(storeSignInUrl("gamestop")).toBe("https://www.gamestop.com/")
    expect(warmupDue(null, 30, 1_000)).toBe(true)
    expect(warmupDue(1_000, 30, 1_000 + 29 * 60_000)).toBe(false)
    expect(warmupDue(1_000, 30, 1_000 + 30 * 60_000)).toBe(true)
  })

  it("does not generate sensor data or impersonate a TLS fingerprint", () => {
    const source = readTree(join(process.cwd(), "src"))
    for (const banned of ["sensor_data", "ja3", "curl-impersonate", "cycletls", "2captcha", "capsolver"]) {
      expect(source.toLowerCase().includes(banned), banned).toBe(false)
    }
  })
})

describe("block rate view", () => {
  it("adds the rolling rate beside a health row", () => {
    const rows = applyBlockRates([
      { store: "target" as StoreId, storeName: "Target", proxy: "Direct", status: 200, verdict: "up", detail: "HTTP 200", ms: 5, blockSamples: 0, blockCount: 0, blockRate: 0 }
    ], [{ store: "target", samples: 4, blocked: 1, rate: 0.25 }])
    expect(rows[0]?.blockRate).toBe(0.25)
    expect(rows[0]?.detail).toContain("25% of 4")
  })
})

function readTree(dir: string): string {
  let text = ""
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "out") continue
      text += readTree(path)
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) text += readFileSync(path, "utf8")
  }
  return text
}
