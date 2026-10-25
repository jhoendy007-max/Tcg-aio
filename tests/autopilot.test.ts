import { describe, expect, it } from "vitest"
import { learnedDue, matchTemplate, pickRotation, replacementAccount, stuckIds } from "../src/engine/autopilot"
import { fetchRecentMail, formatImapDate, type LineSocket } from "../src/engine/imap"
import { allowCheckout } from "../src/engine/limits"
import { readOrderUpdate } from "../src/engine/orders"
import { healthReport, reportDue, shouldRelaunch } from "../src/engine/watchdog"
import { DEFAULT_SETTINGS, type CheckoutRecord, type PublicAccount, type PublicTask, type TaskTemplate } from "../src/shared/types"

const now = Date.parse("2026-10-17T12:00:00Z")

function template(partial: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: "tpl",
    name: "ETB",
    enabled: true,
    store: "target",
    sku: "88897904",
    keywords: "",
    profileIds: ["p1", "p2"],
    accountIds: ["a1", "a2"],
    proxyGroupId: null,
    monitorProxyGroupId: null,
    quantity: 1,
    maxPrice: 40,
    testMode: true,
    confirmPurchase: false,
    group: "",
    lastFiredAt: 0,
    ...partial
  }
}

function account(id: string, store: PublicAccount["store"] = "target"): PublicAccount {
  return {
    id,
    store,
    label: id,
    username: `${id}@example.com`,
    hasPassword: false,
    hasSession: true,
    proxyGroupId: null,
    sessionState: "saved",
    lastWarmAt: null
  }
}

function checkout(partial: Partial<CheckoutRecord>): CheckoutRecord {
  return {
    id: partial.id ?? "c1",
    at: partial.at ?? now,
    store: partial.store ?? "target",
    sku: partial.sku ?? "88897904",
    product: "ETB",
    price: partial.price ?? 30,
    outcome: partial.outcome ?? "success",
    profileName: "Home",
    accountId: partial.accountId,
    profileId: partial.profileId,
    quantity: partial.quantity ?? 1,
    detail: ""
  }
}

function task(partial: Partial<PublicTask> = {}): PublicTask {
  return {
    id: "t1",
    store: "target",
    sku: "88897904",
    quantity: 1,
    profileId: "p1",
    accountId: "a1",
    proxyGroupId: null,
    monitorProxyGroupId: null,
    confirmPurchase: true,
    testMode: false,
    group: "",
    status: "monitoring",
    detail: "",
    logs: [{ ts: now - 20 * 60_000, level: "info", message: "watching" }],
    createdAt: now,
    startedAt: now - 20 * 60_000,
    ...partial
  }
}

describe("autopilot", () => {
  it("matches a template only when the price is under the cap", () => {
    const templates = [template()]
    expect(matchTemplate(templates, { store: "target", sku: "88897904", title: "ETB", price: 39 }, now, 0)?.id).toBe("tpl")
    expect(matchTemplate(templates, { store: "target", sku: "88897904", title: "ETB", price: 41 }, now, 0)).toBeNull()
    expect(matchTemplate(templates, { store: "target", sku: "88897904", title: "ETB", price: null }, now, 0)).toBeNull()
    expect(matchTemplate(templates, { store: "target", sku: "88897904", title: "ETB", price: 20 }, now, 15)).toBeNull()
  })

  it("rotates to the account that has not hit the store limit", () => {
    const settings = { ...DEFAULT_SETTINGS, storePurchaseLimits: "target:1", maxPerAccount: 2 }
    const chosen = pickRotation({
      template: template({ maxPrice: null }),
      accounts: [account("a1"), account("a2")],
      checkouts: [checkout({ accountId: "a1", profileId: "p1" })],
      settings,
      store: "target",
      sku: "88897904",
      quantity: 1,
      price: 20,
      now
    })
    expect(chosen).toMatchObject({ ok: true, accountId: "a2" })
  })

  it("blocks place order when the daily budget is already spent", () => {
    const settings = { ...DEFAULT_SETTINGS, dailyBudget: 40, healthReportZone: "UTC" }
    const decision = allowCheckout(settings, [checkout({ price: 30 })], {
      store: "target",
      sku: "88897904",
      accountId: "a1",
      quantity: 1,
      price: 20,
      now,
      dropStart: null
    })
    expect(decision.ok).toBe(false)
  })

  it("starts from a learned hour when the last price is under the cap", () => {
    const due = learnedDue({
      hints: [{ store: "target", sku: "88897904", hourEt: 8, samples: 2, warmupMin: 15, detail: "two restocks" }],
      templates: [template()],
      tasks: [],
      fired: [],
      now: Date.parse("2026-10-17T12:10:00Z"),
      globalCap: 0,
      priceFor: () => 30
    })
    expect(due).toHaveLength(1)
    expect(learnedDue({
      hints: [{ store: "target", sku: "88897904", hourEt: 8, samples: 2, warmupMin: 15, detail: "two restocks" }],
      templates: [template()],
      tasks: [],
      fired: [],
      now: Date.parse("2026-10-17T12:10:00Z"),
      globalCap: 0,
      priceFor: () => 90
    })).toHaveLength(0)
  })

  it("restarts a quiet task and can move to another saved account", () => {
    expect(stuckIds([task()], now, 15, {})).toEqual(["t1"])
    expect(stuckIds([task()], now, 15, { t1: 3 })).toEqual([])
    const next = replacementAccount([account("a1"), account("a2"), account("a3", "walmart")], "a1", "target", ["a2"])
    expect(next?.id).toBeUndefined()
    expect(replacementAccount([account("a1"), account("a2")], "a1", "target", [])?.id).toBe("a2")
  })

  it("reads a cancellation and a tracking number from mail or an order page", () => {
    expect(readOrderUpdate("Order 42 has been cancelled.", "42")?.status).toBe("cancelled")
    expect(readOrderUpdate("Order 42 shipped. Tracking 1Z999AA10123456784", "42")).toMatchObject({ status: "shipped", tracking: "1Z999AA10123456784" })
  })

  it("reads recent IMAP text without keeping the password in the result", async () => {
    const script = [
      "* OK ready",
      "A1 OK logged in",
      "A2 OK selected",
      "* SEARCH 9",
      "A3 OK search",
      "Order 42 shipped. Tracking 1Z999AA10123456784",
      "A4 OK fetch",
      "A5 OK bye"
    ]
    const socket: LineSocket = {
      async send() {},
      async read() {
        const line = script.shift()
        if (line === undefined) throw new Error("ended")
        return line
      }
    }
    const text = await fetchRecentMail(socket, { user: "ada@example.com", password: "secret-mail", mailbox: "INBOX", since: new Date("2026-10-16T00:00:00Z") })
    expect(text).toContain("1Z999AA10123456784")
    expect(text).not.toContain("secret-mail")
    expect(formatImapDate(new Date("2026-10-16T00:00:00Z"))).toBe("16-Oct-2026")
  })

  it("sends the daily report once the local clock passes the chosen time", () => {
    const settings = { ...DEFAULT_SETTINGS, healthReportTime: "08:00", healthReportZone: "UTC" }
    expect(reportDue("", settings, Date.parse("2026-10-17T07:59:00Z"))).toBe(false)
    expect(reportDue("", settings, Date.parse("2026-10-17T08:00:00Z"))).toBe(true)
    expect(reportDue("2026-10-17", settings, Date.parse("2026-10-17T09:00:00Z"))).toBe(false)
    const text = healthReport({
      accounts: [{ ...account("a1"), sessionState: "expired" }],
      scores: [],
      schedules: [],
      checkouts: [checkout({ at: Date.parse("2026-10-16T15:00:00Z"), price: 12 })],
      settings,
      now: Date.parse("2026-10-17T08:00:00Z")
    })
    expect(text).toContain("1 expired")
    expect(text).toContain("$12.00")
  })

  it("refuses to relaunch again inside the same minute", () => {
    expect(shouldRelaunch(now, now + 10_000)).toBe(false)
    expect(shouldRelaunch(now, now + 60_000)).toBe(true)
  })
})
