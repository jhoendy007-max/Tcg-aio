import { storeName } from "../shared/stores"
import { restockCheckouts } from "../shared/task-role"
import { APP_VERSION } from "../shared/version"
import { isActiveStatus, type AlertsView, type AlertLog, type KeywordWatch, type Notice, type ProxyEndpoint, type RestockRule, type StoreId } from "../shared/types"
import type { Database } from "./database"
import type { HttpClient } from "./http"
import { isListingBlock, listingHeaders, listingSearchUrl, parseListings, type Listing } from "./listings"
import { searchTerms } from "./keywords"
import { keywordsAllow } from "./keywords"
import { parseDiscordContent, parseWebhook, type RestockSignal } from "./restock-parse"
import { dedupeHit, parseAllowlist, sourceAllowed } from "./discord-gate"
import { matchTemplate, planTemplateStart } from "./autopilot"
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
      allowlist: discord.allowlist,
      dedupeMin: discord.dedupeMin,
      channelIds: discord.channelIds.join("\n"),
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

  async ingest(signal: RestockSignal, source: AlertLog["source"], meta?: { channelId?: string; authorId?: string }): Promise<IngestHit[]> {
    const hits: IngestHit[] = []
    const now = Date.now()
    if (source === "webhook" || source === "discord") {
      const gate = this.admit(signal, source, now, meta)
      if (gate) {
        this.emitChange()
        return [gate]
      }
    }
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
          detail: `${rule.name}: ${decision.reason}${signal.title ? ` ${signal.title}` : ""}`,
          inStock: signal.inStock,
          price: signal.price,
          url: signal.url
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Could not start the task."
        hits.push({ rule: rule.name, action: "skip", reason })
        this.log(source, signal, `${rule.name}: ${reason}`)
      }
    }
    const started = hits.some((hit) => hit.action === "start" || hit.action === "create")
    if (!started && this.db.getSettings().autopilot) {
      const launched = await this.launchTemplate(signal, source)
      if (launched) hits.push(launched)
    }
    if (signal.inStock) hits.push(...this.startRestockTasks(signal, source))
    if (!hits.length) this.log(source, signal, "No rule matched.")
    this.emitChange()
    return hits
  }

  async pollDiscordOnce(): Promise<void> {
    const config = this.db.discordWatchConfig()
    if (!config.enabled || !config.token || !config.channelIds.length) return
    for (const channelId of config.channelIds) {
      const stop = await this.pollDiscordChannel(config.token, channelId)
      if (stop) return
    }
  }

  private admit(signal: RestockSignal, source: AlertLog["source"], now: number, meta?: { channelId?: string; authorId?: string }): IngestHit | null {
    const config = this.db.discordWatchConfig()
    const sources = [signal.source, source, meta?.channelId ?? "", meta?.authorId ?? ""]
    if (!sourceAllowed(parseAllowlist(config.allowlist), sources)) {
      this.log(source, signal, "Source is not on the allowlist.")
      return { rule: "", action: "skip", reason: "Source is not on the allowlist." }
    }
    if (!signal.inStock) return null
    const decision = dedupeHit(this.db.alertSeen(), `${signal.store}|${signal.sku}`, now, config.dedupeMin)
    if (!decision.fresh) {
      this.log(source, signal, "Duplicate alert ignored.")
      return { rule: "", action: "skip", reason: "Duplicate alert ignored." }
    }
    this.db.rememberAlerts(decision.seen)
    return null
  }

  private async pollDiscordChannel(token: string, channelId: string): Promise<boolean> {
    let response
    try {
      response = await this.http.request({
        method: "GET",
        url: `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=20`,
        headers: {
          authorization: `Bot ${token}`,
          "user-agent": `Zzz AIO (tcgaio, ${APP_VERSION})`
        },
        timeoutMs: 15000
      })
    } catch (err) {
      this.discordBackoff = Math.min(this.discordBackoff * 2, MAX_BACKOFF_MS)
      this.logLine("discord", "", "", "Discord watcher", err instanceof Error ? err.message : "Discord request failed.")
      return true
    }
    if (response.status === 401 || response.status === 403) {
      this.db.setDiscordEnabled(false)
      this.logLine("discord", "", "", "Discord watcher", "Discord rejected the bot token or channel. The watcher is off.")
      await this.notify({
        kind: "paused",
        storeName: "Discord",
        sku: channelId,
        profileName: "Alerts",
        detail: "Discord rejected the bot token or channel. The watcher is off."
      })
      this.emitChange()
      return true
    }
    if (response.status === 429) {
      this.discordBackoff = Math.min(this.discordBackoff * 2, MAX_BACKOFF_MS)
      this.logLine("discord", "", "", "Discord watcher", "Discord rate limited the bot. Waiting longer before the next read.")
      return true
    }
    if (response.status < 200 || response.status >= 300) {
      this.discordBackoff = Math.min(this.discordBackoff * 2, MAX_BACKOFF_MS)
      this.logLine("discord", "", "", "Discord watcher", `Discord returned ${response.status}.`)
      return true
    }
    this.discordBackoff = DISCORD_MIN_MS
    let messages: { id?: string; content?: string; author?: { id?: string } }[]
    try {
      const parsed = JSON.parse(response.body) as unknown
      messages = Array.isArray(parsed) ? parsed : []
    } catch {
      this.logLine("discord", "", "", "Discord watcher", "Discord returned a response that was not a message list.")
      return false
    }
    const newest = messages.find((message) => typeof message.id === "string")?.id ?? ""
    const cursor = this.db.discordCursor(channelId)
    if (!cursor) {
      if (newest) this.db.setDiscordCursor(channelId, newest)
      this.logLine("discord", "", "", "Discord watcher", "Watcher armed. Messages already in the channel are ignored.")
      this.emitChange()
      return false
    }
    const fresh = messages
      .filter((message) => typeof message.id === "string" && snowflakeAfter(message.id, cursor))
      .reverse()
    for (const message of fresh) {
      for (const signal of parseDiscordContent(message.content ?? "")) {
        signal.source = "discord"
        await this.ingest(signal, "discord", { channelId, authorId: message.author?.id })
      }
    }
    if (newest) this.db.setDiscordCursor(channelId, newest)
    return false
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
        headers: { accept: "text/html,application/json", "user-agent": "TCGAIO-keyword", ...listingHeaders(watch.store) },
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
        if (settings.autopilot) {
          const launched = await this.launchTemplate(signal, "keyword")
          this.logLine("keyword", watch.store, listing.sku, listing.title, launched ? `${watch.name}: ${launched.reason}` : `${watch.name}: new match. Autopilot had no template.`)
          if (launched) {
            await this.notify({
              kind: "alert",
              storeName: storeName(watch.store),
              sku: listing.sku,
              profileName: "Autopilot",
              detail: launched.reason,
              inStock: true,
              price: listing.price,
              url: listing.url
            })
          }
          continue
        }
        this.logLine("keyword", watch.store, listing.sku, listing.title, `${watch.name}: new match. Auto-start is off.`)
        await this.notify({
          kind: "alert",
          storeName: storeName(watch.store),
          sku: listing.sku,
          profileName: "Alerts",
          detail: `${watch.name}: ${listing.title || listing.sku} matches. Auto-start is off.`,
          inStock: true,
          price: listing.price,
          url: listing.url
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
          detail: `${watch.name}: ${decision.reason} ${listing.title}`.trim() + (taskId ? ` Task ${taskId.slice(0, 8)}.` : ""),
          inStock: true,
          price: listing.price,
          url: listing.url
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

  private startRestockTasks(signal: RestockSignal, source: AlertLog["source"]): IngestHit[] {
    const runner = this.getRunner()
    if (!runner) return []
    const hits: IngestHit[] = []
    const matches = restockCheckouts(this.db.listTasks(), signal, (status) => isActiveStatus(status))
    for (const task of matches) {
      if (runner.isRunning(task.id)) continue
      try {
        runner.start(task.id)
        const reason = "Started because this checkout waits for a restock alert."
        hits.push({ rule: "Restock", action: "start", reason, taskId: task.id })
        this.log(source, signal, reason)
      } catch (err) {
        const reason = err instanceof Error ? err.message : "The checkout did not start."
        hits.push({ rule: "Restock", action: "skip", reason, taskId: task.id })
        this.log(source, signal, reason)
      }
    }
    return hits
  }

  private async launchTemplate(signal: RestockSignal, source: AlertLog["source"]): Promise<IngestHit | null> {
    const settings = this.db.getSettings()
    const template = matchTemplate(this.db.listTemplates(), signal, Date.now(), settings.autopilotPriceCap)
    if (!template) return null
    const plan = planTemplateStart({
      template,
      signal,
      accounts: this.db.listAccounts(),
      checkouts: this.db.listCheckouts(),
      settings,
      now: Date.now(),
      profiles: this.db.listProfiles().map((profile) => ({ id: profile.id, last4: profile.last4 }))
    })
    if (!plan.ok) {
      this.log(source, signal, `${template.name}: ${plan.reason}`)
      return { rule: template.name, action: "skip", reason: plan.reason }
    }
    const runner = this.getRunner()
    if (!runner) return { rule: template.name, action: "skip", reason: "The desktop app is still starting." }
    const task = this.db.saveTask(plan.task)
    this.db.touchTemplate(template.id, Date.now())
    runner.start(task.id, plan.task.testMode ? { test: true } : undefined)
    const reason = plan.task.testMode ? `Autopilot started a test from ${template.name}.` : `Autopilot started ${template.name}.`
    this.log(source, signal, reason)
    return { rule: template.name, action: "create", reason, taskId: task.id }
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
    if (this.stopped || !config.enabled || !config.hasBot || !config.channelIds.length) return
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
