import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { challengeSolved, cookieMap, pageShowsChallenge, solvedProbeScript } from "../src/shared/challenge-solved"
import { KeepWarm, nextWarmDelay, type KeepWarmAccount } from "../src/engine/keep-warm"
import { noticeAllowed } from "../src/engine/stock-alerts"
import { cleanMention } from "../src/engine/validate"
import { buildDiscordBody, withPing } from "../src/engine/discord"
import { DEFAULT_SETTINGS } from "../src/shared/types"

const NORMAL = `<html><head><title>Pokemon ETB : Target</title></head><body>${"<div>product</div>".repeat(200)}</body></html>`
const PX = `<html><body><div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human</p>${"x".repeat(2000)}</body></html>`

describe("challenge solved detection (0.2.40)", () => {
  const host = "www.target.com"
  const seed = cookieMap("accessToken=a; _px3=old")
  it("stays waiting while the press-and-hold page is on screen, even if _px3 changed", () => {
    expect(pageShowsChallenge(PX)).toBe(true)
    expect(challengeSolved("target", host, seed, { url: "https://www.target.com/p/-/A-1", html: PX, cookies: { _px3: "new" } }).solved).toBe(false)
  })
  it("waits for Target to rotate _px3 before calling it solved", () => {
    expect(challengeSolved("target", host, seed, { url: "https://www.target.com/p/-/A-1", html: NORMAL, cookies: { _px3: "old" } }).solved).toBe(false)
    const verdict = challengeSolved("target", host, seed, { url: "https://www.target.com/p/-/A-1", html: NORMAL, cookies: { _px3: "new", accessToken: "a" } })
    expect(verdict).toMatchObject({ solved: true })
  })
  it("ignores pages that are still loading or left the store", () => {
    expect(challengeSolved("target", host, seed, { url: "https://www.target.com/", html: "<html></html>", cookies: { _px3: "new" } }).solved).toBe(false)
    expect(challengeSolved("target", host, seed, { url: "https://evil.example/", html: NORMAL, cookies: { _px3: "new" } }).solved).toBe(false)
    expect(challengeSolved("target", host, seed, { url: "not a url", html: NORMAL, cookies: { _px3: "new" } }).solved).toBe(false)
  })

  function runProbe(page: { html: string; cookie: string; host?: string }): string[] {
    const posted: string[] = []
    const timers: Array<() => void> = []
    const document = { get cookie() { return page.cookie }, documentElement: { get outerHTML() { return page.html } } }
    runInNewContext(solvedProbeScript("target", "www.target.com", "accessToken=a; _px3=old"), {
      document,
      location: { get hostname() { return page.host ?? "www.target.com" } },
      window: { ReactNativeWebView: { postMessage: (text: string) => posted.push(text) } },
      setInterval: (fn: () => void) => timers.push(fn)
    })
    const tick = () => timers.forEach((fn) => fn())
    tick()
    page.html = PX
    page.cookie = "accessToken=a; _px3=new"
    tick()
    page.html = NORMAL
    tick()
    tick()
    return posted
  }
  it("the phone WebView probe only reports once, after the person clears the page", () => {
    const posted = runProbe({ html: PX, cookie: "accessToken=a; _px3=old" })
    expect(posted).toHaveLength(1)
    expect(JSON.parse(posted[0])).toEqual({ type: "solved", cookie: "accessToken=a; _px3=new" })
  })
  it("the probe is read-only: it never clicks, dispatches events, or holds anything", () => {
    const script = solvedProbeScript("target", "www.target.com", "")
    for (const banned of ["click", "dispatchEvent", "mousedown", "pointerdown", "touchstart", "KeyboardEvent", "MouseEvent"]) expect(script).not.toContain(banned)
  })
})

describe("challenge notifications (0.2.40)", () => {
  it("'Challenge needs you' is on by default and can be turned off", () => {
    expect(DEFAULT_SETTINGS.notifyChallenge).toBe(true)
    expect(noticeAllowed(DEFAULT_SETTINGS, { kind: "challenge" })).toBe(true)
    expect(noticeAllowed({ ...DEFAULT_SETTINGS, notifyChallenge: false }, { kind: "challenge" })).toBe(false)
  })
  it("Discord ping only accepts a mention token and only pings for challenges", () => {
    expect(cleanMention(" @here ")).toBe("@here")
    expect(cleanMention("<@&123456789>")).toBe("<@&123456789>")
    expect(cleanMention("")).toBe("")
    expect(() => cleanMention("hello @everyone")).toThrow()
    const notice = { kind: "challenge" as const, storeName: "Target", sku: "88897904", profileName: "", detail: "check" }
    const body = withPing(buildDiscordBody(notice), notice, "<@123456789>")
    expect(body.content).toContain("<@123456789>")
    expect(body.allowed_mentions).toEqual({ users: ["123456789"] })
    const quiet = withPing(buildDiscordBody({ ...notice, kind: "success" }), { ...notice, kind: "success" }, "@here")
    expect(quiet.content).toBeUndefined()
  })
})

describe("Target keep-warm (0.2.40)", () => {
  const accounts: KeepWarmAccount[] = [
    { id: "t1", label: "Main", store: "target", hasSession: true },
    { id: "t2", label: "Busy", store: "target", hasSession: true },
    { id: "w1", label: "Walmart", store: "walmart", hasSession: true },
    { id: "t3", label: "Signed out", store: "target", hasSession: false }
  ]
  it("jitters the interval ±25% and clamps it to 10–120 min", () => {
    expect(nextWarmDelay(20, () => 0)).toBe(15 * 60_000)
    expect(nextWarmDelay(20, () => 1)).toBe(25 * 60_000)
    expect(nextWarmDelay(1, () => 0.5)).toBe(10 * 60_000)
    expect(nextWarmDelay(999, () => 0.5)).toBe(120 * 60_000)
  })
  it("warms only idle signed-in Target accounts, and stops + alerts when a check appears", async () => {
    const warmed: string[] = []
    const alerts: string[] = []
    const logs: string[] = []
    let challenge = false
    const keeper = new KeepWarm({
      settings: () => ({ keepWarm: true, keepWarmMin: 25 }),
      accounts: () => accounts,
      busy: (id) => id === "t2",
      warm: async (id) => {
        warmed.push(id)
        return { expired: false, detail: "", challenged: challenge }
      },
      log: (message) => logs.push(message),
      alert: (account) => alerts.push(account.id),
      setTimer: () => 1,
      clearTimer: () => undefined
    })
    await keeper.tick()
    expect(warmed).toEqual(["t1"])
    expect(logs.some((line) => line.includes("skipped Busy"))).toBe(true)
    challenge = true
    await keeper.tick()
    expect(alerts).toEqual(["t1"])
    expect(keeper.stopped.has("t1")).toBe(true)
    await keeper.tick()
    expect(warmed).toEqual(["t1", "t1"])
  })
  it("does nothing while switched off", async () => {
    const warmed: string[] = []
    let armed = 0
    const keeper = new KeepWarm({
      settings: () => ({ keepWarm: false }),
      accounts: () => accounts,
      busy: () => false,
      warm: async (id) => { warmed.push(id); return { expired: false, detail: "" } },
      log: () => undefined,
      alert: () => undefined,
      setTimer: () => { armed += 1; return 1 }
    })
    keeper.start()
    await keeper.tick()
    expect(armed).toBe(0)
    expect(warmed).toEqual([])
  })
})
