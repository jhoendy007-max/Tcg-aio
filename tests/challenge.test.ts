import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { applySolvedCookies, challengePageUrl, classifyChallenge } from "../src/engine/challenge"
import { ChallengeGate } from "../src/engine/challenge-gate"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { TaskService } from "../src/engine/task-runner"
import { FinalSubmitBlocked, finishTest } from "../src/engine/test-mode"
import { asClientMessage } from "../src/phone/protocol"
import type { HttpClient } from "../src/engine/http"
import type { Notice } from "../src/shared/types"
import type { StoreModule } from "../src/stores/module"
import { AMAZON_PAUSE } from "../src/stores/amazon"
import { BESTBUY_PAUSE } from "../src/stores/bestbuy"
import { CRUNCHYROLL_PAUSE } from "../src/stores/crunchyroll"
import { POKEMON_CENTER_PAUSE } from "../src/stores/pokemon-center"
import { TARGET_PAUSE } from "../src/stores/target"
import { WALMART_PAUSE } from "../src/stores/walmart"

const SESSION_PAUSES = [
  "Paste a Walmart browser session (auth and CID cookies) on the account. Password sign-in is blocked by PerimeterX, and TCGAIO does not solve challenges.",
  "Amazon asked for a two-step verification code. Approve it in your own browser, paste a fresh session if needed, then resume. TCGAIO does not solve challenges.",
  "Amazon asked for the card security code. Finish checkout in your browser. TCGAIO does not send card numbers or CVVs.",
  "The Amazon session expired. Paste a fresh www.amazon.com cookie header, then resume.",
  "Paste a signed-in Best Buy browser session (the cookie header from www.bestbuy.com). Password sign-in is blocked by Akamai, and TCGAIO does not solve challenges.",
  "The Best Buy session is not signed in. Paste the cookie header from a signed-in browser, then resume.",
  "Paste a signed-in Pokémon Center browser session (the cookie header from www.pokemoncenter.com). Password sign-in is blocked by Incapsula, and TCGAIO does not solve challenges.",
  "Paste a signed-in Crunchyroll Store session (the www.crunchyroll.com cookie header or the shopper access token). Password sign-in is blocked by Cloudflare, and TCGAIO does not solve challenges."
]

const address = {
  firstName: "Ada",
  lastName: "Lovelace",
  line1: "1 Main St",
  line2: "",
  city: "New York",
  state: "NY",
  zip: "10001",
  country: "US" as const
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tcgaio-challenge-"))
  const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
  db.load()
  const profile = db.saveProfile({
    name: "Home",
    email: "ada@example.com",
    phone: "2125550100",
    shipping: address,
    billing: address,
    cardName: "Ada Lovelace",
    cardNumber: "4242424242424242",
    expMonth: "12",
    expYear: "2030",
    cvv: "123",
    cardAction: "replace"
  })
  const account = db.saveAccount({
    store: "target",
    label: "Main",
    username: "ada@example.com",
    password: "",
    passwordAction: "clear",
    session: "accessToken=token-1; visitorId=visitor-1",
    sessionAction: "replace"
  })
  const task = db.saveTask({
    store: "target",
    sku: "88897904",
    quantity: 1,
    profileId: profile.id,
    accountId: account.id,
    proxyGroupId: null,
    confirmPurchase: true,
    testMode: true
  })
  return { db, task, account }
}

describe("challenge classification", () => {
  it("recognizes an active challenge and leaves session pauses alone", () => {
    for (const reason of [
      TARGET_PAUSE,
      WALMART_PAUSE,
      AMAZON_PAUSE,
      BESTBUY_PAUSE,
      POKEMON_CENTER_PAUSE,
      "Pokémon Center's waiting room asked for a captcha. Finish it in your own browser, then resume. TCGAIO does not solve challenges.",
      CRUNCHYROLL_PAUSE
    ]) {
      expect(classifyChallenge(reason), reason).toBe(true)
    }
    for (const reason of SESSION_PAUSES) expect(classifyChallenge(reason), reason).toBe(false)
    expect(classifyChallenge("blocked by PerimeterX")).toBe(false)
    expect(classifyChallenge("TCGAIO does not solve challenges.")).toBe(false)
  })

  it("opens the store page for the task", () => {
    expect(challengePageUrl("target", "88897904")).toBe("https://www.target.com/p/-/A-88897904")
    expect(challengePageUrl("walmart", "123456789")).toBe("https://www.walmart.com/ip/123456789")
    expect(challengePageUrl("amazon", "B0RETAILER")).toBe("https://www.amazon.com/dp/B0RETAILER")
    expect(challengePageUrl("pokemon-center", "sku-1")).toContain("https://www.pokemoncenter.com/")
    expect(challengePageUrl("crunchyroll", "12345678")).toContain("https://www.crunchyroll.com/")
    expect(challengePageUrl("bestbuy", "6530584")).toContain("https://www.bestbuy.com/")
  })
})

describe("solved cookies", () => {
  it("merges new cookies and keeps tokens the page did not replace", () => {
    const merged = applySolvedCookies(
      { accessToken: "token-1", visitorId: "visitor-1", cookie: "accessToken=token-1; visitorId=visitor-1" },
      "_px3=solved; accessToken=token-2"
    )
    expect(merged.accessToken).toBe("token-2")
    expect(merged.visitorId).toBe("visitor-1")
    expect(merged.cookie).toContain("_px3=solved")
    expect(merged.cookie).toContain("visitorId=visitor-1")
  })

  it("accepts a single challenge cookie and rejects an empty or broken header", () => {
    const merged = applySolvedCookies({ accessToken: "token-1", cookie: "accessToken=token-1" }, "datadome=abc")
    expect(merged.accessToken).toBe("token-1")
    expect(merged.cookie).toContain("datadome=abc")
    expect(() => applySolvedCookies(undefined, "   ")).toThrow(/empty/)
    expect(() => applySolvedCookies(undefined, "a=b\nSet-Cookie: c=d")).toThrow(/one cookie line/)
    expect(() => applySolvedCookies(undefined, "x".repeat(9000))).toThrow(/too large/)
  })
})

describe("challenge handoff", () => {
  it("keeps the proxy password off the phone view", async () => {
    const gate = new ChallengeGate()
    const signal = new AbortController().signal
    const pending = gate.wait({
      taskId: "task-1",
      store: "target",
      storeName: "Target",
      sku: "88897904",
      url: "https://www.target.com/p/-/A-88897904",
      reason: TARGET_PAUSE,
      proxyLabel: "10.0.0.1:8000",
      cookie: "accessToken=token-1",
      proxy: { id: "p1", host: "10.0.0.1", port: 8000, username: "user", password: "secret-pass" }
    }, signal, 30)
    expect(JSON.stringify(gate.current())).not.toContain("secret-pass")
    expect(gate.phoneView()?.cookie).toBe("accessToken=token-1")
    expect(JSON.stringify(gate.phoneView())).not.toContain("secret-pass")
    gate.dismiss(gate.current()!.id)
    await expect(pending).resolves.toEqual({ kind: "dismissed" })
  })

  it("resumes once with the solved cookies and still blocks place order", async () => {
    const { db, task, account } = setup()
    const seen: string[] = []
    const http: HttpClient = {
      async request(input) {
        seen.push(input.url)
        if (input.url.includes("/web_checkouts/v1/checkout")) throw new Error("place order reached the network")
        return { status: 200, headers: {}, body: "" }
      }
    }
    let runs = 0
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        runs += 1
        if (runs === 1) return { outcome: "paused", reason: TARGET_PAUSE }
        expect(ctx.account.session?.cookie).toContain("_px3=solved")
        expect(ctx.account.session?.accessToken).toBe("token-2")
        await ctx.http.request({ method: "POST", url: "https://www.target.com/checkout_payments/v1/payment_instructions", body: "{}" })
        await expect(ctx.http.request({ method: "POST", url: "https://www.target.com/web_checkouts/v1/checkout", body: "{}" })).rejects.toBeInstanceOf(FinalSubmitBlocked)
        return finishTest(ctx)
      }
    }
    const gate = new ChallengeGate()
    const notices: Notice[] = []
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async (notice) => {
      notices.push(notice)
      return true
    }, http, gate)
    service.start(task.id, { test: true })
    await vi.waitFor(() => expect(gate.current()).not.toBeNull())
    expect(db.getTask(task.id).status).toBe("challenge")
    gate.submit(gate.current()!.id, "_px3=solved; accessToken=token-2")
    await service.wait(task.id)
    expect(runs).toBe(2)
    expect(db.getTask(task.id).status).toBe("tested")
    expect(db.readAccount(account.id).session?.cookie).toContain("_px3=solved")
    expect(seen.some((url) => url.includes("/web_checkouts/v1/checkout"))).toBe(false)
    expect(seen.some((url) => url.includes("/checkout_payments/v1/payment_instructions"))).toBe(true)
    expect(notices.map((notice) => notice.kind)).toEqual(["challenge", "tested"])
    expect(JSON.stringify(notices)).not.toContain("secret")
  })

  it("pauses when the person does not solve in time and does not run again", async () => {
    vi.useFakeTimers()
    try {
      const { db, task } = setup()
      db.saveSettings({ ...db.getSettings(), challengeTimeoutSec: 30 })
      let runs = 0
      const module: StoreModule = {
        id: "target",
        displayName: "Target",
        skuHint: "TCIN",
        implemented: true,
        async run() {
          runs += 1
          return { outcome: "paused", reason: TARGET_PAUSE }
        }
      }
      const gate = new ChallengeGate()
      const notices: Notice[] = []
      const service = new TaskService(db, new Map([["target", module]]), () => undefined, async (notice) => {
        notices.push(notice)
        return false
      }, undefined, gate)
      service.start(task.id, { test: true })
      for (let i = 0; i < 20 && !gate.current(); i += 1) await Promise.resolve()
      expect(gate.current()).not.toBeNull()
      await vi.advanceTimersByTimeAsync(30_000)
      await service.wait(task.id)
      expect(runs).toBe(1)
      expect(db.getTask(task.id).status).toBe("paused")
      expect(db.getTask(task.id).detail).toContain("timed out")
      expect(notices.map((notice) => notice.kind)).toEqual(["challenge", "paused"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("pauses a second challenge in the same start instead of asking again", async () => {
    const { db, task } = setup()
    let runs = 0
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run() {
        runs += 1
        return { outcome: "paused", reason: TARGET_PAUSE }
      }
    }
    const gate = new ChallengeGate()
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false, undefined, gate)
    service.start(task.id, { test: true })
    await vi.waitFor(() => expect(gate.current()).not.toBeNull())
    gate.submit(gate.current()!.id, "_px3=again")
    await service.wait(task.id)
    expect(runs).toBe(2)
    expect(db.getTask(task.id).status).toBe("paused")
    expect(gate.current()).toBeNull()
  })

  it("stops while a person is solving", async () => {
    const { db, task } = setup()
    let runs = 0
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run() {
        runs += 1
        return { outcome: "paused", reason: WALMART_PAUSE }
      }
    }
    const gate = new ChallengeGate()
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false, undefined, gate)
    service.start(task.id)
    await vi.waitFor(() => expect(gate.current()).not.toBeNull())
    service.stop(task.id)
    await service.wait(task.id)
    expect(runs).toBe(1)
    expect(db.getTask(task.id).status).toBe("stopped")
  })

  it("still pauses when no handoff gate is installed", async () => {
    const { db, task } = setup()
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run() {
        return { outcome: "paused", reason: TARGET_PAUSE }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false)
    service.start(task.id)
    await service.wait(task.id)
    expect(db.getTask(task.id).status).toBe("paused")
  })
})

describe("challenge messages", () => {
  it("accepts a phone solve and ignores a solving service", () => {
    const parsed = asClientMessage({ type: "challenge.submit", req: "r1", conn: "c1", cookie: "_px3=solved" })
    expect(parsed).toEqual({ type: "challenge.submit", req: "r1", conn: "c1", cookie: "_px3=solved" })
    expect(asClientMessage({ type: "challenge.dismiss", req: "r1", conn: "c1" }).type).toBe("challenge.dismiss")
    const source = readTree(join(process.cwd(), "src"))
    for (const host of ["2captcha", "capsolver", "anti-captcha", "anticaptcha", "capmonster", "deathbycaptcha", "nopecha"]) {
      expect(source.toLowerCase().includes(host), host).toBe(false)
    }
  })
})

function readTree(dir: string): string {
  let text = ""
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) {
      if (name === "node_modules" || name === "out") continue
      text += readTree(path)
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      text += readFileSync(path, "utf8")
    }
  }
  return text
}
