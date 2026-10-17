import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { calendarTaskInputs, parseCalendar } from "../src/engine/calendar"
import { clonedTaskInputs } from "../src/engine/clone-task"
import { Database } from "../src/engine/database"
import { dedupeHit, parseAllowlist, sourceAllowed } from "../src/engine/discord-gate"
import { allowCheckout } from "../src/engine/limits"
import { readOrderUpdate, shipmentFromMail } from "../src/engine/orders"
import { rehearsalDue, rehearseDrop } from "../src/engine/rehearsal"
import { dropOpsText } from "../src/shared/drop-ops"
import { DEFAULT_SETTINGS } from "../src/shared/types"
import type { CheckoutRecord, PublicAccount, PublicProfile, PublicTask, ProxyScore } from "../src/shared/types"

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

function profile(last4 = "4242"): PublicProfile {
  return {
    id: "profile-1",
    name: "Home",
    email: "ada@example.com",
    phone: "2125550100",
    shipping: address,
    billing: address,
    cardName: "Ada",
    last4,
    expMonth: "12",
    expYear: "2030"
  }
}

function account(patch: Partial<PublicAccount> = {}): PublicAccount {
  return {
    id: "acct-1",
    store: "target",
    label: "Main",
    username: "ada@example.com",
    hasPassword: false,
    hasSession: true,
    proxyGroupId: "group-a",
    sessionState: "saved",
    lastWarmAt: Date.now(),
    stickyProxyId: "proxy-a",
    stickyProxyLabel: "10.0.0.1:8000",
    profilePartition: "persist:account-acct-1",
    freshness: "fresh",
    ...patch
  }
}

function task(patch: Partial<PublicTask> = {}): PublicTask {
  return {
    id: "task-1",
    store: "target",
    sku: "88897904",
    quantity: 1,
    profileId: "profile-1",
    accountId: "acct-1",
    proxyGroupId: "group-task",
    monitorProxyGroupId: "group-monitor",
    confirmPurchase: false,
    testMode: true,
    group: "ETB",
    status: "idle",
    detail: "",
    logs: [],
    createdAt: 1,
    ...patch
  }
}

function checkout(patch: Partial<CheckoutRecord> = {}): CheckoutRecord {
  return {
    id: "row-1",
    at: Date.UTC(2026, 9, 17, 15),
    store: "target",
    sku: "88897904",
    product: "ETB",
    price: 49.99,
    outcome: "success",
    profileName: "Home",
    accountId: "acct-1",
    profileId: "profile-1",
    quantity: 1,
    last4: "4242",
    detail: "ok",
    ...patch
  }
}

describe("drop operations", () => {
  it("imports Pokémon and One Piece dates and skips other games", () => {
    const json = parseCalendar(JSON.stringify([
      { game: "pokemon", name: "Prismatic ETB", start: "2026-11-07T09:00", store: "target", sku: "88897904" },
      { game: "one piece", name: "OP-15", start: "2026-11-07T13:00:00Z", store: "bestbuy", sku: "6632100" },
      { game: "magic", name: "Foundations", start: "2026-11-07T09:00", store: "target", sku: "1" }
    ]))
    expect("events" in json).toBe(true)
    if (!("events" in json)) return
    expect(json.events.map((event) => event.game)).toEqual(["pokemon", "onepiece"])
    expect(json.skipped).toBe(1)
    expect(json.events[0].startAt).toBeGreaterThan(0)

    const ics = parseCalendar(`BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:One Piece TCG OP-15
DTSTART:20261107T130000Z
DESCRIPTION:store=target sku=88897904
END:VEVENT
BEGIN:VEVENT
SUMMARY:Lorcana set
DTSTART:20261108T130000Z
DESCRIPTION:store=target sku=999
END:VEVENT
END:VCALENDAR`)
    expect("events" in ics && ics.events).toHaveLength(1)
    if (!("events" in ics)) return
    expect(ics.events[0].store).toBe("target")
    expect(ics.events[0].sku).toBe("88897904")
    expect(parseCalendar(JSON.stringify([{ game: "yugioh", name: "Set", start: "2026-11-07T09:00", store: "target", sku: "1" }]))).toEqual({ error: "Only Pokémon and One Piece events can be imported." })
  })

  it("creates one scheduled task per account on that account's proxy group", () => {
    const inputs = calendarTaskInputs({
      event: { name: "Prismatic ETB", store: "target", sku: "88897904" },
      accounts: [
        { id: "a", store: "target", proxyGroupId: "sticky-a" },
        { id: "b", store: "target", proxyGroupId: "sticky-b" },
        { id: "c", store: "walmart", proxyGroupId: "other" }
      ],
      profileId: "profile-1",
      quantity: 1,
      testMode: true,
      confirmPurchase: false
    })
    expect(inputs).toHaveLength(2)
    expect(inputs.map((item) => item.proxyGroupId)).toEqual(["sticky-a", "sticky-b"])
    expect(inputs.every((item) => item.monitorProxyGroupId === null)).toBe(true)
    expect(inputs.every((item) => item.profileId === "profile-1")).toBe(true)
  })

  it("clones a task onto each account without copying a conflicting proxy", () => {
    const planned = clonedTaskInputs(task(), [
      account({ id: "acct-2", label: "Second", proxyGroupId: "sticky-2" }),
      account({ id: "acct-3", store: "walmart", proxyGroupId: "nope" })
    ])
    expect(planned.skipped).toEqual(["acct-3"])
    expect(planned.inputs).toHaveLength(1)
    expect(planned.inputs[0]).toMatchObject({
      accountId: "acct-2",
      profileId: "profile-1",
      proxyGroupId: "sticky-2",
      monitorProxyGroupId: null,
      sku: "88897904"
    })
    expect(planned.inputs[0].proxyGroupId).not.toBe("group-task")
  })

  it("allowlists sources and drops a duplicate SKU inside the window", () => {
    expect(sourceAllowed([], ["webhook"])).toBe(true)
    const list = parseAllowlist("123\nRestockR\n123")
    expect(sourceAllowed(list, ["webhook", "restockr"])).toBe(true)
    expect(sourceAllowed(list, ["other-bot"])).toBe(false)
    const first = dedupeHit([], "target|88897904", 1_000, 30)
    expect(first.fresh).toBe(true)
    const again = dedupeHit(first.seen, "target|88897904", 1_000 + 60_000, 30)
    expect(again.fresh).toBe(false)
    const later = dedupeHit(first.seen, "target|88897904", 1_000 + 31 * 60_000, 30)
    expect(later.fresh).toBe(true)
    expect(dedupeHit(first.seen, "target|88897904", 2_000, 0).fresh).toBe(true)
  })

  it("rehearses sessions, proxies, and cards without placing an order", () => {
    const now = Date.UTC(2026, 10, 7, 12, 0)
    const startAt = now + 10 * 60_000
    expect(rehearsalDue({ enabled: true, phase: "waiting", startAt, rehearsalMin: 15, rehearsalAt: null }, now)).toBe(true)
    expect(rehearsalDue({ enabled: true, phase: "waiting", startAt, rehearsalMin: 0, rehearsalAt: null }, now)).toBe(false)
    const scores: ProxyScore[] = [{ proxyId: "proxy-a", streak: 3, ok: 1, blocks: 3, benchedUntil: now + 60_000, lastStatus: 403 }]
    const failed = rehearseDrop({
      tasks: [task()],
      accounts: [account({ hasSession: false, sessionState: "missing", lastWarmAt: null, stickyProxyId: "proxy-a" })],
      profiles: [profile("")],
      scores,
      now,
      freshMin: 30
    })
    expect(failed.ok).toBe(false)
    expect(failed.detail).toContain("No order was placed.")
    expect(failed.detail).toContain("no saved session")
    expect(failed.detail).toContain("quarantined")
    expect(failed.detail.toLowerCase()).not.toContain("place-order")
    const passed = rehearseDrop({
      tasks: [task()],
      accounts: [account({ lastWarmAt: now })],
      profiles: [profile()],
      scores: [{ proxyId: "proxy-a", streak: 0, ok: 4, blocks: 0, benchedUntil: 0, lastStatus: 200 }],
      now,
      freshMin: 30,
      lang: "es"
    })
    expect(passed.ok).toBe(true)
    expect(passed.detail).toContain(dropOpsText("es", "noOrder"))
    const source = readFileSync(join(process.cwd(), "src/engine/rehearsal.ts"), "utf8")
    expect(source).not.toContain("isFinalSubmit")
  })

  it("reads a shipping email into a per-order status", () => {
    const ups = shipmentFromMail("Order 42 shipped via UPS. Tracking 1Z999AA10123456784", "42")
    expect(ups).toMatchObject({ status: "shipped", tracking: "1Z999AA10123456784", carrier: "UPS" })
    const delivered = shipmentFromMail("Order 42 was delivered by USPS. Tracking 9400111899223344556677", "42")
    expect(delivered).toMatchObject({ status: "delivered", carrier: "USPS" })
    expect(shipmentFromMail("Order 77 is out for delivery. Tracking 123456789012", "77")?.status).toBe("out")
    expect(readOrderUpdate("Order 42 shipped. Tracking 1Z999AA10123456784", "42")).toMatchObject({ status: "shipped", tracking: "1Z999AA10123456784" })
    expect(shipmentFromMail("Thanks for shopping", "42")).toBeNull()
  })

  it("stops an order that would pass the account or card daily cap", () => {
    const now = Date.UTC(2026, 9, 17, 16)
    const settings = { ...DEFAULT_SETTINGS, healthReportZone: "UTC", accountDailySpend: 60, cardDailySpend: 0, cardDailyOrders: 0 }
    const blocked = allowCheckout(settings, [checkout()], {
      store: "target",
      sku: "88897904",
      accountId: "acct-1",
      quantity: 1,
      price: 20,
      now,
      dropStart: null,
      last4: "4242"
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toContain("not placed")
    const otherAccount = allowCheckout(settings, [checkout()], {
      store: "target",
      sku: "88897904",
      accountId: "acct-2",
      quantity: 1,
      price: 20,
      now,
      dropStart: null,
      last4: "4242"
    })
    expect(otherAccount.ok).toBe(true)
    const cardSpend = allowCheckout({ ...DEFAULT_SETTINGS, healthReportZone: "UTC", cardDailySpend: 40 }, [checkout()], {
      store: "target",
      sku: "111",
      accountId: "acct-2",
      quantity: 1,
      price: 10,
      now,
      dropStart: null,
      last4: "4242"
    })
    expect(cardSpend.ok).toBe(false)
    const cardCount = allowCheckout({ ...DEFAULT_SETTINGS, healthReportZone: "UTC", cardDailyOrders: 1 }, [checkout()], {
      store: "target",
      sku: "111",
      accountId: "acct-9",
      quantity: 1,
      price: 10,
      now,
      dropStart: null,
      last4: "4242"
    })
    expect(cardCount.ok).toBe(false)
    const missingCard = allowCheckout({ ...DEFAULT_SETTINGS, cardDailyOrders: 1 }, [], {
      store: "target",
      sku: "111",
      accountId: "acct-1",
      quantity: 1,
      price: 10,
      now,
      dropStart: null
    })
    expect(missingCard.ok).toBe(false)
    const off = allowCheckout(DEFAULT_SETTINGS, [checkout({ price: 5000 })], {
      store: "target",
      sku: "88897904",
      accountId: "acct-1",
      quantity: 1,
      price: 5000,
      now,
      dropStart: null,
      last4: "4242"
    })
    expect(off.ok).toBe(true)
  })

  it("saves a calendar drop, a clone, and a last four without the card number", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-drop-ops-"))
    const file = join(dir, "tcgaio.json")
    const db = new Database(file, createAesCipher(dir))
    db.load()
    const savedProfile = db.saveProfile({
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
    const groupA = db.saveProxyGroup({ name: "A", text: "10.0.0.1:8000" })
    const groupB = db.saveProxyGroup({ name: "B", text: "10.0.0.2:8000" })
    const first = db.saveAccount({
      store: "target",
      label: "One",
      username: "one@example.com",
      password: "",
      passwordAction: "clear",
      session: "",
      sessionAction: "clear",
      proxyGroupId: groupA.id
    })
    const second = db.saveAccount({
      store: "target",
      label: "Two",
      username: "two@example.com",
      password: "",
      passwordAction: "clear",
      session: "",
      sessionAction: "clear",
      proxyGroupId: groupB.id
    })
    const origin = db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: savedProfile.id,
      accountId: first.id,
      proxyGroupId: groupA.id,
      monitorProxyGroupId: groupA.id,
      confirmPurchase: false,
      testMode: true
    })
    const copies = db.cloneAcrossAccounts(origin.id, [second.id])
    expect(copies).toHaveLength(1)
    expect(copies[0].accountId).toBe(second.id)
    expect(copies[0].proxyGroupId).toBe(groupB.id)
    expect(copies[0].monitorProxyGroupId).toBeNull()
    expect(copies[0].profileId).toBe(savedProfile.id)
    const event = db.saveCalendarEvent({
      game: "pokemon",
      name: "Prismatic ETB",
      startAt: "2026-11-07T09:00",
      store: "target",
      sku: "88897904"
    })
    const created = db.createCalendarDrop({
      eventId: event.id,
      accountIds: [first.id, second.id],
      profileId: savedProfile.id,
      quantity: 1,
      warmupMin: 10,
      rehearsalMin: 20,
      testMode: true,
      confirmPurchase: true
    })
    expect(created.tasks).toHaveLength(2)
    expect(created.tasks.map((item) => item.proxyGroupId).sort()).toEqual([groupA.id, groupB.id].sort())
    expect(created.schedule.rehearsalMin).toBe(20)
    expect(created.tasks.every((item) => item.testMode && !item.confirmPurchase)).toBe(true)
    const row = db.recordCheckout({
      store: "target",
      sku: "88897904",
      product: "ETB",
      outcome: "success",
      profileName: "Home",
      detail: "Order 42",
      accountId: first.id,
      profileId: savedProfile.id,
      quantity: 1,
      last4: savedProfile.last4,
      price: 49.99
    })
    expect(row.last4).toBe("4242")
    expect(readFileSync(file, "utf8")).not.toContain("4242424242424242")
    db.saveDiscordWatch({
      channelId: "123456789012345678",
      channelIds: "123456789012345678\n223456789012345678",
      allowlist: "123456789012345678",
      dedupeMin: 15,
      enabled: true,
      token: "bot-token-value-that-is-long-enough",
      tokenAction: "replace"
    })
    const watch = db.discordWatchConfig()
    expect(watch.channelIds).toEqual(["123456789012345678", "223456789012345678"])
    expect(watch.allowlist).toBe("123456789012345678")
    expect(watch.dedupeMin).toBe(15)
    expect(readFileSync(file, "utf8")).not.toContain("bot-token-value-that-is-long-enough")
    expect(dropOpsText("es", "calendarTitle")).toContain("Calendario")
  })
})
