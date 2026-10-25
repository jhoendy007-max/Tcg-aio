import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { checkoutCsv, priceFromDetail, summarize } from "../src/engine/analytics"
import { parseBulkTasks } from "../src/engine/bulk"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { planDrops, scheduleAction } from "../src/engine/drops"
import { compareVersions, pickRelease, readReleases } from "../src/engine/releases"
import { countdown } from "../src/shared/clock"
import { easternDay, formatEastern, parseEasternLocal, toEasternInput } from "../src/engine/time"
import type { CheckoutRecord } from "../src/shared/types"

describe("Eastern time", () => {
  it("reads a wall clock as New York time and follows daylight saving", () => {
    const winter = parseEasternLocal("2026-11-13T09:00")
    const summer = parseEasternLocal("2026-07-13T09:00")
    expect(new Date(winter).toISOString()).toBe("2026-11-13T14:00:00.000Z")
    expect(new Date(summer).toISOString()).toBe("2026-07-13T13:00:00.000Z")
    expect(toEasternInput(winter)).toBe("2026-11-13T09:00")
    expect(toEasternInput(summer)).toBe("2026-07-13T09:00")
    expect(easternDay(winter - 60_000)).toBe("2026-11-13")
    expect(formatEastern(winter)).toContain("09:00")
    expect(formatEastern(winter)).toContain("EST")
    expect(formatEastern(summer)).toContain("EDT")
  })

  it("handles the daylight-saving change days", () => {
    // 2026-11-01 01:30 happens twice. The first one (EDT) wins.
    expect(new Date(parseEasternLocal("2026-11-01T01:30")).toISOString()).toBe("2026-11-01T05:30:00.000Z")
    // 2026-03-08 02:30 does not exist. It lands right after the gap.
    expect(new Date(parseEasternLocal("2026-03-08T02:30")).toISOString()).toBe("2026-03-08T07:30:00.000Z")
    // Round trip through the form field never changes the instant.
    for (const text of ["2026-03-08T01:59", "2026-03-08T03:00", "2026-11-01T00:59", "2026-11-01T02:00", "2026-12-24T18:45"]) {
      expect(toEasternInput(parseEasternLocal(text))).toBe(text)
    }
  })

  it("keeps saved epoch times valid: a drop saved while the label said Atlantic fires at the same instant", () => {
    const saved = Date.UTC(2026, 10, 13, 13, 0) // what 09:00 "Atlantic" stored
    expect(toEasternInput(saved)).toBe("2026-11-13T08:00")
    expect(parseEasternLocal(toEasternInput(saved))).toBe(saved)
  })

  it("counts a drop down from an absolute timestamp", () => {
    const now = 1_000_000
    expect(countdown(now - 1, now)).toBe("now")
    expect(countdown(now + 45_000, now)).toBe("0m 45s")
    expect(countdown(now + 3_700_000, now)).toBe("1h 1m")
    expect(countdown(now + 90_000_000, now)).toBe("1d 1h")
  })
})

describe("drop scheduler", () => {
  const base = { enabled: true, startAt: 1_000_000, stopAt: 1_500_000, warmupMin: 10, phase: "waiting" as const }
  it("warms before the start, starts on time, and stops after", () => {
    expect(scheduleAction(base, base.startAt - 11 * 60_000)).toBe("wait")
    expect(scheduleAction(base, base.startAt - 9 * 60_000)).toBe("warm")
    expect(scheduleAction({ ...base, phase: "warming" }, base.startAt - 1000)).toBe("wait")
    expect(scheduleAction(base, base.startAt)).toBe("start")
    expect(scheduleAction({ ...base, phase: "started" }, base.startAt + 1000)).toBe("idle")
    expect(scheduleAction({ ...base, phase: "started" }, base.stopAt)).toBe("stop")
    expect(scheduleAction(base, base.stopAt)).toBe("missed")
    const plans = planDrops(
      [{ ...base, id: "d1", name: "ETB", taskIds: [], group: "etb" }],
      [{ id: "t1", accountId: "a1", group: "ETB" }, { id: "t2", accountId: "a1", group: "other" }],
      base.startAt
    )
    expect(plans[0]).toMatchObject({ action: "start", taskIds: ["t1"], accountIds: ["a1"] })
  })
})

describe("analytics", () => {
  it("totals wins, spend, and a daily timeline without leaking a password", () => {
    const records: CheckoutRecord[] = [
      row("success", 49.99, parseEasternLocal("2026-11-13T09:00")),
      row("failure", null, parseEasternLocal("2026-11-13T10:00")),
      row("paused", null, parseEasternLocal("2026-11-14T09:00")),
      row("tested", 10, parseEasternLocal("2026-11-14T11:00"))
    ]
    const report = summarize(records)
    expect(report.success).toBe(1)
    expect(report.winRate).toBeCloseTo(1 / 3)
    expect(report.spend).toBe(49.99)
    expect(report.tested).toBe(1)
    expect(report.byStore[0]?.storeName).toBe("Target")
    expect(report.timeline.map((point) => point.day)).toEqual(["2026-11-13", "2026-11-14"])
    expect(priceFromDetail("Charged $49.99")).toBe(49.99)
    const csv = checkoutCsv(records)
    expect(csv.split("\n")).toHaveLength(5)
    expect(csv).not.toContain("secret-pass")
    expect(csv).not.toContain("4242")
  })

  it("returns an empty report when the checkout list is missing", () => {
    expect(summarize(undefined).attempts).toBe(0)
    expect(summarize(null).timeline).toEqual([])
    expect(checkoutCsv(undefined).split("\n")).toEqual(["at,store,sku,product,price,outcome,profile,orderId,detail"])
  })
})

describe("mass tasks", () => {
  it("reads URLs and CSV into shared tasks", () => {
    const parsed = parseBulkTasks({
      store: "target",
      quantity: 1,
      profileId: "p",
      accountId: "a",
      proxyGroupId: null,
      confirmPurchase: false,
      testMode: true,
      group: "wave",
      text: "https://www.target.com/p/-/A-88897904\nhttps://www.walmart.com/ip/sephora/123456789\nsku,quantity,group\n94724620,2,case"
    })
    expect(parsed.errors).toEqual([])
    expect(parsed.tasks.map((task) => [task.store, task.sku, task.quantity, task.group])).toEqual([
      ["target", "88897904", 1, "wave"],
      ["walmart", "123456789", 1, "wave"],
      ["target", "94724620", 2, "case"]
    ])
    expect(parsed.tasks.every((task) => task.testMode && task.profileId === "p")).toBe(true)
  })
})

describe("releases", () => {
  it("picks the newest prerelease with an exe and an apk and ignores drafts", () => {
    const releases = readReleases(JSON.stringify([
      { tag_name: "v0.2.4-beta", draft: false, body: "older", assets: [{ name: "TCGAIO-Setup-0.2.4.exe" }, { name: "TCGAIO-Phone-0.2.4.apk" }] },
      { tag_name: "v0.2.5-beta", draft: true, body: "hidden", assets: [{ name: "TCGAIO-Setup-0.2.5.exe" }] },
      { tag_name: "v0.2.5-beta", draft: false, body: "Session Keeper\nDrops", assets: [{ name: "TCGAIO-Phone-0.2.5.apk" }, { name: "latest.yml" }, { name: "TCGAIO-Setup-0.2.5.exe" }] }
    ]))
    const picked = pickRelease(releases)
    expect(compareVersions("0.2.5-beta", "0.2.4")).toBe(1)
    expect(picked?.version).toBe("0.2.5-beta")
    expect(picked?.exe).toBe("TCGAIO-Setup-0.2.5.exe")
    expect(picked?.apk).toBe("TCGAIO-Phone-0.2.5.apk")
    expect(picked?.notes).toContain("Session Keeper")
    expect(JSON.stringify(picked)).not.toContain("github_pat")
  })
})

describe("saved desk data", () => {
  it("schedules a drop, records a checkout, and keeps the GitHub token off the report", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-desk-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const profile = db.saveProfile({
      name: "Ada", email: "ada@example.com", phone: "2125550100",
      shipping: address(), billing: address(),
      cardName: "Ada", cardNumber: "4242424242424242", cvv: "123", expMonth: "12", expYear: "2030", cardAction: "replace"
    })
    const account = db.saveAccount({
      store: "target", label: "Main", username: "ada@example.com",
      password: "", passwordAction: "clear", session: "", sessionAction: "clear"
    })
    const task = db.saveTask({ store: "target", sku: "88897904", quantity: 1, profileId: profile.id, accountId: account.id, proxyGroupId: null, confirmPurchase: false, testMode: true, group: "etb" })
    const copy = db.duplicateTasks([task.id])
    expect(copy[0]?.id).not.toBe(task.id)
    expect(copy[0]?.group).toBe("etb")
    const schedule = db.saveSchedule({ name: "Friday", enabled: true, startAt: "2026-11-13T09:00", stopAt: "2026-11-13T09:05", warmupMin: 15, taskIds: [task.id], group: "etb" })
    expect(schedule.startAt).toBe(parseEasternLocal("2026-11-13T09:00"))
    db.recordCheckout({ store: "target", sku: task.sku, product: task.sku, outcome: "success", profileName: "Ada", detail: "Order 1 for $12.00", orderId: "1" })
    expect(db.analytics().spend).toBe(12)
    db.setUpdateToken("replace", "github_pat_secret_value")
    expect(db.hasUpdateToken()).toBe(true)
    expect(JSON.stringify(db.analytics())).not.toContain("github_pat")
    expect(JSON.stringify(db.updateNotice())).not.toContain("github_pat")
    expect(db.checkoutCsv()).not.toContain("4242")
  })
})

function row(outcome: CheckoutRecord["outcome"], price: number | null, at: number): CheckoutRecord {
  return { id: outcome + at, at, store: "target", sku: "88897904", product: "ETB", price, outcome, profileName: "Ada", detail: "ok" }
}

function address() {
  return { firstName: "Ada", lastName: "Lovelace", line1: "1 Main", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" as const }
}
