import { describe, expect, it } from "vitest"
import { PoliteLimiter, STORE_GAP_MS } from "../src/engine/polite"
import { chooseSticky, noteScore } from "../src/engine/proxy-hygiene"
import { storeHome } from "../src/engine/session-care"
import {
  accountPartition,
  consistencyText,
  dueRefreshes,
  dueWarmups,
  effectiveBinding,
  healthScore,
  planWarmup,
  sessionFreshness,
  SessionWindowQueue,
  staggerPlan
} from "../src/shared/consistency"
import type { FreshAccount } from "../src/shared/consistency"
import type { ProxyEndpoint } from "../src/shared/types"

const proxies: ProxyEndpoint[] = [
  { id: "a", host: "10.0.0.1", port: 8000 },
  { id: "b", host: "10.0.0.2", port: 8000 },
  { id: "c", host: "10.0.0.3", port: 8000 }
]

const account = (id: string, lastWarmAt: number | null, sessionState: FreshAccount["sessionState"] = "saved"): FreshAccount => ({
  id,
  store: "target",
  hasSession: sessionState !== "missing",
  sessionState,
  lastWarmAt
})

describe("session consistency", () => {
  it("gives each account its own profile and an unshared proxy", () => {
    expect(accountPartition("one")).toBe("persist:account-one")
    expect(accountPartition("one")).not.toBe(accountPartition("two"))
    const first = chooseSticky(proxies, [], [], "acct-1", "group", 0)
    const second = chooseSticky(proxies, first.pins, [], "acct-2", "group", 0)
    expect(first.choice.proxy?.id).toBe("a")
    expect(second.choice.proxy?.id).toBe("b")
    expect(second.choice.proxy?.id).not.toBe(first.choice.proxy?.id)
    const third = chooseSticky([proxies[0]], second.pins, [], "acct-3", "group", 0)
    expect(third.choice.proxy).toBeUndefined()
    expect(third.choice.allBenched).toBe(true)
    const held = chooseSticky([proxies[2]], first.pins, [], "acct-1", "other", 0)
    expect(held.choice.stickyOutside).toBe(true)
    expect(held.choice.heldProxyId).toBe("a")
    expect(held.pins.find((pin) => pin.accountId === "acct-1")?.proxyId).toBe("a")
  })

  it("quarantines 403, 412, and 435, and leaves 429 on the proxy", () => {
    let scores = noteScore([], "a", 429, 0)
    expect(scores[0]?.benchedUntil).toBe(0)
    expect(scores[0]?.blocks).toBe(0)
    expect(healthScore(scores[0])).toBe(100)
    scores = noteScore(scores, "a", 200, 0)
    scores = noteScore(scores, "a", 403, 0)
    expect(healthScore(scores[0])).toBe(50)
    const task = chooseSticky(proxies, [], [], "task-1", "group", 0, false)
    const again = chooseSticky(proxies, task.pins, [], "task-2", "group", 0, false)
    expect(again.choice.proxy?.id).toBe(task.choice.proxy?.id)
  })

  it("shares a pace clock across an account or a proxy, and jitters the gap", async () => {
    let now = 0
    const waits: number[] = []
    const limiter = new PoliteLimiter(() => now, async (ms) => {
      waits.push(ms)
      now += ms
    }, () => 0)
    const send = (share: { accountId?: string; proxyId?: string; jitterPct?: number }) => limiter.wrap("target", share.proxyId, {
      async request() {
        return { status: 200, headers: {}, body: "" }
      }
    }, () => undefined, undefined, { ...share, gapMs: 1000 }).request({ method: "GET", url: "https://www.target.com/" })
    await send({ accountId: "acct", proxyId: "p1" })
    await send({ accountId: "acct", proxyId: "p2" })
    expect(waits).toEqual([1000])
    let now2 = 0
    const waits2: number[] = []
    const byProxy = new PoliteLimiter(() => now2, async (ms) => {
      waits2.push(ms)
      now2 += ms
    }, () => 0)
    const sendProxy = (share: { accountId: string; proxyId: string }) => byProxy.wrap("target", share.proxyId, {
      async request() {
        return { status: 200, headers: {}, body: "" }
      }
    }, () => undefined, undefined, { ...share, gapMs: 1000 }).request({ method: "GET", url: "https://www.target.com/" })
    await sendProxy({ accountId: "a", proxyId: "p1" })
    await sendProxy({ accountId: "b", proxyId: "p1" })
    expect(waits2).toEqual([1000])
    await sendProxy({ accountId: "c", proxyId: "p9" })
    expect(waits2).toEqual([1000])
    const jittered = new PoliteLimiter(() => 0, async (ms) => {
      waits.push(ms)
    }, () => 0)
    await jittered.wrap("walmart", "p1", {
      async request() {
        return { status: 200, headers: {}, body: "" }
      }
    }, () => undefined, undefined, { proxyId: "p1", gapMs: 1000, jitterPct: 20 }).request({ method: "GET", url: "https://www.walmart.com/" })
    await jittered.wrap("walmart", "p1", {
      async request() {
        return { status: 200, headers: {}, body: "" }
      }
    }, () => undefined, undefined, { proxyId: "p1", gapMs: 1000, jitterPct: 20 }).request({ method: "GET", url: "https://www.walmart.com/" })
    expect(waits.at(-1)).toBe(Math.max(250, Math.round(1000 * 0.8)))
    expect(STORE_GAP_MS.walmart).toBeGreaterThan(0)
  })

  it("plans a human-paced browse with no cart, and staggers near-expiry refreshes", () => {
    const dropAt = 10 * 86_400_000
    const early = planWarmup([account("a", null), account("b", null)], dropAt, dropAt - 3 * 86_400_000, true)
    expect(early).toEqual([])
    const planned = planWarmup([account("a", null), account("b", null)], dropAt, dropAt - 86_400_000, true)
    expect(planned.map((step) => step.kind).every((kind) => kind === "browse" || kind === "signin-check")).toBe(true)
    expect(planned[1].at - planned[0].at).toBeGreaterThanOrEqual(45_000)
    for (const step of planned) expect(storeHome(step.store)).not.toMatch(/cart|checkout|place-order|add-to-cart/i)
    expect(planWarmup([account("a", null)], dropAt, dropAt - 86_400_000, false)).toEqual([])
    const due = dueWarmups([account("a", dropAt), account("b", null)], dropAt, dropAt - 86_400_000, true)
    expect(due.map((step) => step.accountId)).toEqual(["b"])
    const now = dropAt - 60_000
    const slots = staggerPlan([
      account("a", now - 2 * 60 * 60_000),
      account("b", now - 2 * 60 * 60_000),
      account("c", now),
      account("d", null, "expired")
    ], dropAt, now, 30)
    expect(slots.map((slot) => slot.accountId)).toEqual(["a", "b", "d"])
    expect(slots[slots.length - 1].at - slots[0].at).toBeGreaterThan(60_000)
    expect(slots.every((slot) => slot.at < dropAt)).toBe(true)
    expect(dueRefreshes([account("a", now)], dropAt, now, 30)).toEqual([])
    expect(sessionFreshness(account("a", now), now, 30)).toBe("fresh")
    expect(consistencyText("es", "stickyWarning")).toContain("proxy fijo")
    expect(consistencyText("en", "residentialNote")).toContain("residential")
  })

  it("shows where a task's account, proxy, and profile came from", () => {
    const groups = [{ id: "home", name: "Home", proxies: [{ id: "a" }] }, { id: "other", name: "Other", proxies: [{ id: "b" }] }]
    const bound = effectiveBinding({
      accountId: "acct",
      proxyGroupId: "other",
      monitorProxyGroupId: "other",
      account: { id: "acct", label: "Ada", proxyGroupId: "home", stickyProxyId: "a", stickyProxyLabel: "10.0.0.1:8000" },
      groups
    })
    expect(bound.profileLabel).toBe("persist:account-acct")
    expect(bound.proxySource).toBe("account")
    expect(bound.accountSource).toBe("task")
    expect(bound.warnings).toContain("sticky")
    expect(bound.warnings).toContain("monitor")
    const open = effectiveBinding({ accountId: "", proxyGroupId: "home", monitorProxyGroupId: null, account: null, groups })
    expect(open.proxySource).toBe("task")
    expect(open.profileSource).toBe("none")
    expect(open.warnings).toEqual([])
  })

  it("queues hidden session windows past the cap", async () => {
    const queue = new SessionWindowQueue(3)
    let running = 0
    let max = 0
    const release: Array<() => void> = []
    const jobs = Array.from({ length: 5 }, () => queue.run(() => new Promise<void>((done) => {
      running += 1
      max = Math.max(max, running)
      release.push(() => {
        running -= 1
        done()
      })
    })))
    let cursor = 0
    const finishOne = () => {
      release[cursor]()
      cursor += 1
    }
    await flush()
    expect(running).toBe(3)
    expect(max).toBe(3)
    expect(release).toHaveLength(3)
    finishOne()
    await flush()
    expect(running).toBe(3)
    expect(release).toHaveLength(4)
    finishOne()
    await flush()
    expect(release).toHaveLength(5)
    expect(max).toBe(3)
    while (cursor < release.length) {
      finishOne()
      await flush()
    }
    await Promise.all(jobs)
    expect(running).toBe(0)
  })
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
