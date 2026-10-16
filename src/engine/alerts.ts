import { storeName } from "../shared/stores"
import type { AlertsView, AlertLog, KeywordWatch, Notice, ProxyEndpoint, RestockRule, StoreId } from "../shared/types"
import type { Database } from "./database"
import type { HttpClient } from "./http"
import { isListingBlock, listingSearchUrl, parseListings, type Listing } from "./listings"
import { searchTerms } from "./keywords"
import { keywordsAllow } from "./keywords"
import { parseDiscordContent, parseWebhook, type RestockSignal } from "./restock-parse"
import { decideRestock } from "./restock-rules"
import { tokenAccepted } from "./body"
import type { TaskService } from "./task-runner"

const MIN_WATCH_MS = 5000
const MAX_BACKOFF_MS = 120_000
const DISCORD_MIN_MS = 15_000
const MAX_STARTS_PER_PASS = 3

export interface IngestHit {
  rule: string
  action: "start" | "create" | "skip"
  reason: string
  taskId?: string
}

export function relayRestockUrl(relay: string, pcId: string): string {
  if (!relay.trim() || !pcId) return ""
  try {
    const url = new URL(relay.trim())
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return ""
    url.protocol = url.protocol === "wss:" ? "https:" : "http:"
    url.pathname = `/v1/restock/${encodeURIComponent(pcId)}`
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return ""
  }
}

export class AlertService {
  private watchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private inflight = new Set<string>()
  private backoff = new Map<string, number>()
  private proxyCursor = new Map<string, number>()
  private discordTimer: ReturnType<typeof setTimeout> | null = null
  private discordBackoff = DISCORD_MIN_MS
  private stopped = false
  private urls = { localUrl: "", relayUrl: "" }
  private readonly onChangeCbs = new Set<() => void>()

  constructor(
    private readonly db: Database,
    private readonly getRunner: () => TaskService | null,
    private readonly notify: (notice: Notice) => Promise<boolean>,
    private readonly http: HttpClient
  ) {}

  onChange(cb: () => void): () => void {
    this.onChangeCbs.add(cb)
    return () => this.onChangeCbs.delete(cb)
  }

  start(): void {
    this.stopped = false
    this.refresh()
  }

  stop(): void {
    this.stopped = true
    if (this.discordTimer) clearTimeout(this.discordTimer)
    this.discordTimer = null
    for (const timer of this.watchTimers.values()) clearTimeout(timer)
    this.watchTimers.clear()
  }

  refresh(): void {
    if (this.stopped) return
    this.armDiscord()
    const live = new Set<string>()
    for (const watch of this.db.listWatches()) {
      live.add(watch.id)
      if (watch.enabled && watch.status !== "blocked") this.armWatch(watch.id, this.watchDelay(watch.id))
      else this.clearWatch(watch.id)
    }
    for (const id of [...this.watchTimers.keys()]) {
      if (!live.has(id)) this.clearWatch(id)
    }
    this.emitChange()
  }

  setUrls(urls: { localUrl: string; relayUrl: string }): void {
    this.urls = urls
  }

  phoneAlerts() {
    const view = this.view(this.urls)
    return {
      localUrl: view.localUrl,
      relayUrl: view.relayUrl,
      discordWatch: view.discordWatch,
      hasBot: view.hasBot,
      channelId: view.channelId,
      rules: view.rules,
      watches: view.watches,
      log: view.log
    }
  }

  view(urls: { localUrl: string; relayUrl: string }): AlertsView {
    if (!this.db.restockToken()) this.db.rotateRestockToken()
    const discord = this.db.discordWatchConfig()
    return {
      localUrl: urls.localUrl,
      relayUrl: urls.relayUrl,
      token: this.db.restockToken(),
      discordWatch: discord.enabled,
      hasBot: discord.hasBot,
      channelId: discord.channelId,
      rules: this.db.listRestockRules(),
      watches: this.db.listWatches(),
      log: this.db.listAlertLog()
    }
  }

  async ingestHttp(authorization: string | undefined, alternate: string | undefined, raw: string): Promise<{ status: number; body: string }> {
    if (!tokenAccepted(authorization, alternate, this.db.restockToken())) {
      return json(401, { ok: false, error: "Unauthorized." })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return json(400, { ok: false, error: "Body must be JSON." })
    }
    const signals = parseWebhook(parsed)
    if ("error" in signals) return json(400, { ok: false, error: signals.error })
    const results = []
    for (const signal of signals.signals) results.push({ sku: signal.sku, store: signal.store, hits: await this.ingest(signal, "webhook") })
    return json(200, { ok: true, results })
  }

  async ingest(signal: RestockSignal, source: AlertLog["source"]): Promise<IngestHit[]> {
    const hits: IngestHit[] = []
    const now = Date.now()
    const globalTestMode = this.db.getSettings().testMode
    for (const rule of this.db.listRestockRules()) {
      const task = rule.taskId ? this.findTask(rule.taskId) : null
      const decision = decideRestock({ rule, signal, now, globalTestMode, task })
      if (decision.action === "skip" && quietSkip(decision.reason)) continue
      if (decision.action === "skip") {
        hits.push({ rule: rule.name, action: "skip", reason: decision.reason })
        this.log(source, signal, `${rule.name}: ${decision.reason}`)
        continue
      }
      try {
        const taskId = await this.apply(rule, signal, decision)
        this.db.touchRestockRule(rule.id, now)
        hits.push({ rule: rule.name, action: decision.action, reason: decision.reason, taskId })
        this.log(source, signal, `${rule.name}: ${decision.reason}`)
        await this.notify({
          kind: "alert",
          storeName: storeName(signal.store),
          sku: signal.sku,
          profileName: "Alerts",
          detail: `${rule.name}: ${decision.reason}${signal.title ? ` ${signal.title}` : ""}`
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Could not start the task."
        hits.push({ rule: rule.name, action: "skip", reason })
        this.log(source, signal, `${rule.name}: ${reason}`)
      }
    }
    if (!hits.length) this.log(source, signal, "No rule matched.")
    this.emitChange()
    return hits
  }

  async pollDiscordOnce(): Promise<void> {
    const config = this.db.discordWatchConfig()
    if (!config.enabled || !config.token || !config.channelId) return
    let response
    try {
      response = await this.http.request({
        method: "GET",
        url: `https://discord.com/api/v10/channels/${encodeURIComponent(config.channelId)}/messages?limit=20`,
        headers: {
          authorization: `Bot ${config.token}`,
          "user-agent": "TCGAIO (tcgaio, 0.2.4)"
        },
        timeoutMs: 15000
      })
    } catch (err) {
      this.discordBackoff = Math.min(this.discordBackoff * 2, MAX_BACKOFF_MS)
      this.logLine("discord", "", "", "Discord watcher", err instanceof Error ? err.message : "Discord request failed.")
      return
    }
    if (response.status === 401 || response.status === 403) {
      this.db.setDiscordEnabled(false)
      this.logLine("discord", "", "", "Discord watcher", "Discord rejected the bot token or channel. The watcher is off.")
      await this.notify({
        kind: "paused",
        storeName: "Discord",
        sku: config.channelId,
        profileName: "Alerts",
        detail: "Discord rejected the bot token or channel. The watcher is off."
      })
      this.emitChange()
      return
    }
    if (response.status === 429) {
      this.discordBackoff = Math.min(this.discordBackoff * 2, MAX_BACKOFF_MS)
      this.logLine("discord", "", "", "Discord watcher", "Discord rate limited the bot. Waiting longer before the next read.")
      return
    }
    if (response.status < 200 || response.status >= 300) {
      this.discordBackoff = Math.min(this.discordBackoff * 2, MAX_BACKOFF_MS)
      this.logLine("discord", "", "", "Discord watcher", `Discord returned ${response.status}.`)
      return
    }
    this.discordBackoff = DISCORD_MIN_MS
    let messages: { id?: string; content?: string }[]
    try {
      const parsed = JSON.parse(response.body) as unknown
      messages = Array.isArray(parsed) ? parsed : []
    } catch {
      this.logLine("discord", "", "", "Discord watcher", "Discord returned a response that was not a message list.")
      return
    }
    const newest = messages.find((message) => typeof message.id === "string")?.id ?? ""
    if (!config.lastMessageId) {
      if (newest) this.db.setDiscordCursor(newest)
      this.logLine("discord", "", "", "Discord watcher", "Watcher armed. Messages already in the channel are ignored.")
      this.emitChange()
      return
    }
    const fresh = messages
      .filter((message) => typeof message.id === "string" && snowflakeAfter(message.id, config.lastMessageId))
      .reverse()
    for (const message of fresh) {
      for (const signal of parseDiscordContent(message.content ?? "")) {
        signal.source = "discord"
        await this.ingest(signal, "discord")
      }
    }
    if (newest) this.db.setDiscordCursor(newest)
  }

  async pollWatchOnce(id: string): Promise<void> {
    if (this.inflight.has(id)) return
    this.inflight.add(id)
    try {
      await this.pollWatchBody(id)
    } finally {
      this.inflight.delete(id)
    }
  }

  private async pollWatchBody(id: string): Promise<void> {
    const watch = this.db.listWatches().find((item) => item.id === id)
    if (!watch || !watch.enabled || watch.status === "blocked") return
    const terms = searchTerms(watch.keywords)
    if (!terms) {
      this.db.patchWatch(watch.id, { status: "paused", detail: "Add at least one positive keyword." })
      this.clearWatch(watch.id)
      this.emitChange()
      return
    }
    const proxies = this.proxiesFor(watch.proxyGroupId)
    const cursor = this.proxyCursor.get(watch.id) ?? 0
    const proxy = proxies.length ? proxies[cursor % proxies.length] : undefined
    const settings = this.db.getSettings()
    let response
    try {
      response = await this.http.request({
        method: "GET",
        url: listingSearchUrl(watch.store, terms, settings),
        headers: { accept: "text/html,application/json", "user-agent": "TCGAIO-keyword" },
        proxy,
        timeoutMs: 20000
      })
    } catch (err) {
      this.advanceProxy(watch.id, proxies.length)
      this.backoff.set(watch.id, Math.min((this.backoff.get(watch.id) ?? this.baseDelay()) * 2, MAX_BACKOFF_MS))
      this.db.patchWatch(watch.id, { status: "watching", detail: err instanceof Error ? err.message : "Search request failed. Retrying on the next proxy." })
      this.emitChange()
      return
    }
    if (isListingBlock(response.status, response.body)) {
      this.advanceProxy(watch.id, proxies.length)
      this.db.patchWatch(watch.id, { status: "blocked", detail: `Search was blocked (HTTP ${response.status}). Resume to try the next proxy.` })
      this.clearWatch(watch.id)
      this.logLine("keyword", watch.store, "", watch.name, `Paused. Search was blocked (HTTP ${response.status}).`)
      await this.notify({
        kind: "paused",
        storeName: storeName(watch.store),
        sku: watch.keywords,
        profileName: "Alerts",
        detail: `${watch.name} paused. The ${storeName(watch.store)} search was blocked. Resume on the Alerts page to try the next proxy.`
      })
      this.emitChange()
      return
    }
    if (response.status < 200 || response.status >= 400) {
      this.advanceProxy(watch.id, proxies.length)
      this.backoff.set(watch.id, Math.min((this.backoff.get(watch.id) ?? this.baseDelay()) * 2, MAX_BACKOFF_MS))
      this.db.patchWatch(watch.id, { status: "watching", detail: `Search returned HTTP ${response.status}. Retrying.` })
      this.emitChange()
      return
    }
    this.backoff.set(watch.id, this.baseDelay())
    const listings = parseListings(watch.store, response.body).filter((listing) => this.listingMatches(watch, listing))
    const fresh = listings.filter((listing) => !watch.seenSkus.includes(listing.sku))
    const batch = fresh.slice(0, MAX_STARTS_PER_PASS)
    const seen = watch.seenSkus.slice()
    for (const listing of batch) {
      seen.push(listing.sku)
      const signal = listingSignal(listing)
      if (!watch.autoStart) {
        this.logLine("keyword", watch.store, listing.sku, listing.title, `${watch.name}: new match. Auto-start is off.`)
        await this.notify({
          kind: "alert",
          storeName: storeName(watch.store),
          sku: listing.sku,
          profileName: "Alerts",
          detail: `${watch.name}: ${listing.title || listing.sku} matches. Auto-start is off.`
        })
        continue
      }
      const rule = watchAsRule(watch)
      const decision = decideRestock({
        rule,
        signal,
        now: Date.now(),
        globalTestMode: settings.testMode,
        task: null
      })
      if (decision.action === "skip") {
        this.logLine("keyword", watch.store, listing.sku, listing.title, `${watch.name}: ${decision.reason}`)
        continue
      }
      try {
        const taskId = await this.apply(rule, signal, decision)
        this.logLine("keyword", watch.store, listing.sku, listing.title, `${watch.name}: ${decision.reason}`)
        await this.notify({
          kind: "alert",
          storeName: storeName(watch.store),
          sku: listing.sku,
          profileName: "Alerts",
          detail: `${watch.name}: ${decision.reason} ${listing.title}`.trim() + (taskId ? ` Task ${taskId.slice(0, 8)}.` : "")
        })
      } catch (err) {
        this.logLine("keyword", watch.store, listing.sku, listing.title, err instanceof Error ? err.message : "Could not start the task.")
      }
    }
    const waiting = fresh.length - batch.length
    const detail = batch.length
      ? `${batch.length} new match${batch.length === 1 ? "" : "es"}${waiting > 0 ? `, ${waiting} waiting for the next pass` : ""}.`
      : `Watching ${storeName(watch.store)}. No new match.`
    this.db.patchWatch(watch.id, { status: "watching", detail, seenSkus: seen.slice(-300) })
    this.emitChange()
  }

  private async apply(rule: RestockRule, signal: RestockSignal, decision: Extract<ReturnType<typeof decideRestock>, { action: "start" | "create" }>): Promise<string> {
    const runner = this.getRunner()
    if (!runner) throw new Error("The desktop app is still starting.")
    if (decision.action === "start") {
      runner.start(decision.taskId, decision.testMode ? { test: true } : undefined)
      return decision.taskId
    }
    const account = this.db.listAccounts().find((item) => item.id === rule.accountId)
    if (!account) throw new Error("Account not found.")
    if (account.store !== signal.store) throw new Error("Account is for a different store.")
    const task = this.db.saveTask({
      store: signal.store,
      sku: signal.sku,
      quantity: decision.quantity,
      profileId: rule.profileId,
      accountId: rule.accountId,
      proxyGroupId: rule.proxyGroupId,
      confirmPurchase: !decision.testMode && rule.confirmPurchase,
      testMode: decision.testMode
    })
    runner.start(task.id, decision.testMode ? { test: true } : undefined)
    return task.id
  }

  private listingMatches(watch: KeywordWatch, listing: Listing): boolean {
    if (listing.store !== watch.store) return false
    if (!keywordsAllow(watch.keywords, `${listing.title} ${listing.sku}`)) return false
    if (watch.soldByRetailer && listing.sellerKnown && !listing.retailer) return false
    if (watch.maxPrice !== null && (listing.price === null || listing.price > watch.maxPrice)) return false
    return true
  }

  private findTask(id: string): { id: string; store: StoreId; quantity: number; confirmPurchase: boolean; testMode: boolean } | null {
    try {
      const task = this.db.getTask(id)
      return { id: task.id, store: task.store, quantity: task.quantity, confirmPurchase: task.confirmPurchase, testMode: task.testMode }
    } catch {
      return null
    }
  }

  private proxiesFor(groupId: string | null): ProxyEndpoint[] {
    if (!groupId) return []
    try {
      return this.db.getProxyGroup(groupId).proxies
    } catch {
      return []
    }
  }

  private advanceProxy(id: string, count: number): void {
    if (count < 2) return
    this.proxyCursor.set(id, (this.proxyCursor.get(id) ?? 0) + 1)
  }

  private log(source: AlertLog["source"], signal: RestockSignal, result: string): void {
    this.logLine(source, signal.store, signal.sku, signal.title, result)
  }

  private logLine(source: AlertLog["source"], store: string, sku: string, title: string, result: string): void {
    this.db.appendAlertLog({ ts: Date.now(), source, store, sku, title, result })
  }

  private emitChange(): void {
    for (const cb of this.onChangeCbs) cb()
  }

  private armDiscord(): void {
    if (this.discordTimer) clearTimeout(this.discordTimer)
    this.discordTimer = null
    const config = this.db.discordWatchConfig()
    if (this.stopped || !config.enabled || !config.hasBot || !config.channelId) return
    this.discordTimer = setTimeout(() => {
      void this.pollDiscordOnce().finally(() => {
        if (!this.stopped) this.armDiscord()
      })
    }, this.discordBackoff)
  }

  private armWatch(id: string, delay: number): void {
    if (this.watchTimers.has(id) || this.stopped) return
    const timer = setTimeout(() => {
      this.watchTimers.delete(id)
      void this.pollWatchOnce(id).finally(() => {
        const watch = this.db.listWatches().find((item) => item.id === id)
        if (!this.stopped && watch?.enabled && watch.status !== "blocked") this.armWatch(id, this.watchDelay(id))
      })
    }, delay)
    this.watchTimers.set(id, timer)
  }

  private clearWatch(id: string): void {
    const timer = this.watchTimers.get(id)
    if (timer) clearTimeout(timer)
    this.watchTimers.delete(id)
  }

  private watchDelay(id: string): number {
    return Math.max(this.baseDelay(), this.backoff.get(id) ?? 0)
  }

  private baseDelay(): number {
    return Math.max(MIN_WATCH_MS, this.db.getSettings().monitorDelayMs)
  }
}

function watchAsRule(watch: KeywordWatch): RestockRule {
  return {
    id: watch.id,
    name: watch.name,
    enabled: true,
    store: watch.store,
    sku: "",
    keywords: watch.keywords,
    taskId: null,
    profileId: watch.profileId,
    accountId: watch.accountId,
    proxyGroupId: watch.proxyGroupId,
    quantity: watch.quantity,
    maxQuantity: watch.maxQuantity,
    maxPrice: watch.maxPrice,
    cooldownSec: 0,
    testMode: watch.testMode,
    confirmPurchase: watch.confirmPurchase,
    lastFiredAt: 0
  }
}

function listingSignal(listing: Listing): RestockSignal {
  return {
    store: listing.store,
    sku: listing.sku,
    title: listing.title,
    price: listing.price,
    url: listing.url,
    quantity: null,
    soldBy: listing.retailer ? storeName(listing.store) : "",
    inStock: true,
    source: "keyword"
  }
}

function quietSkip(reason: string): boolean {
  return reason === "Rule is off."
    || reason === "Store does not match."
    || reason === "SKU does not match."
    || reason === "Keywords do not match."
    || reason === "Signal says the item is out of stock."
    || reason === "Rule needs a SKU or keywords."
}

function snowflakeAfter(id: string, cursor: string): boolean {
  try {
    return BigInt(id) > BigInt(cursor)
  } catch {
    return id > cursor
  }
}

function json(status: number, body: unknown): { status: number; body: string } {
  return { status, body: JSON.stringify(body) }
}
