import { AppError } from "../shared/errors"
import { redact } from "../shared/redact"
import type { Notice, Settings } from "../shared/types"
import type { HttpClient } from "./http"
import { defaultHttp } from "./http"

const HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"])

export function assertDiscordWebhook(url: string): void {
  if (!url.trim()) return
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new AppError("Discord webhook must be a URL.")
  }
  if (parsed.protocol !== "https:" || !HOSTS.has(parsed.hostname.toLowerCase()) || !parsed.pathname.startsWith("/api/webhooks/")) {
    throw new AppError("Webhook must be an https://discord.com/api/webhooks/ URL.")
  }
}

/** Public copy of the Zzz logo (docs/brand/zzz-logo.png on main) so Discord can show it. */
export const BRAND_ICON_URL = "https://raw.githubusercontent.com/jhoendy007-max/Tcg-aio/main/docs/brand/zzz-logo.png"
const BRAND_AUTHOR = { name: "Zzz AIO", icon_url: BRAND_ICON_URL }
const BRAND_FOOTER = { text: "Zzz AIO · Cop while you sleep", icon_url: BRAND_ICON_URL }

const STORE_ICON_BASE = "https://raw.githubusercontent.com/jhoendy007-max/Tcg-aio/main/docs/brand/stores/"
const STORE_ICONS = new Set(["amazon", "bandai", "barnes-noble", "bestbuy", "costco", "crunchyroll", "gamestop", "pokemon-center", "sams", "target", "tcgplayer", "walmart"])

export function storeIconUrl(store: string | undefined): string | undefined {
  return store && STORE_ICONS.has(store) ? `${STORE_ICON_BASE}${store}.png` : undefined
}

function productLink(notice: Notice): string | undefined {
  if (notice.url && /^https:\/\//.test(notice.url)) return notice.url
  if (/^https:\/\//.test(notice.sku)) return notice.sku
  return undefined
}

/** In-stock / out-of-stock embed: product, image, store, price, SKU, link, time. */
export function buildStockBody(notice: Notice): { embeds: Array<Record<string, unknown>> } {
  const inStock = notice.kind === "instock"
  const link = productLink(notice)
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Store", value: notice.storeName || "—", inline: true },
    { name: "Price", value: notice.price != null ? `$${notice.price.toFixed(2)}` : "—", inline: true },
    { name: "SKU", value: (notice.sku || "—").slice(0, 200), inline: true }
  ]
  if (link) fields.push({ name: "Link", value: `[Open product page](${link})` })
  return {
    embeds: [
      {
        title: `${inStock ? "🟢 In stock" : "🔴 Out of stock"} · ${(notice.title || notice.sku).slice(0, 200)}`,
        url: link,
        color: inStock ? 0x39ff88 : 0xff4d6d,
        description: redact(notice.detail || "").slice(0, 600) || undefined,
        fields,
        thumbnail: notice.imageUrl && /^https:\/\//.test(notice.imageUrl) ? { url: notice.imageUrl } : storeIconUrl(notice.store) ? { url: storeIconUrl(notice.store) } : undefined,
        author: { name: `Zzz AIO · ${notice.storeName}`, icon_url: storeIconUrl(notice.store) ?? BRAND_ICON_URL },
        footer: BRAND_FOOTER,
        timestamp: new Date(notice.at ?? Date.now()).toISOString()
      }
    ]
  }
}

export function buildDiscordBody(notice: Notice): { embeds: Array<Record<string, unknown>> } {
  if (notice.kind === "instock" || notice.kind === "oos") return buildStockBody(notice)
  const color = notice.kind === "success"
    ? 0x3cba8b
    : notice.kind === "tested" || notice.kind === "alert"
      ? 0x6aa6ff
      : notice.kind === "drop" || notice.kind === "health"
        ? 0x6aa6ff
        : notice.kind === "paused" || notice.kind === "challenge" || notice.kind === "session" || notice.kind === "blocked"
          ? 0xe0a045
          : 0xe25b5b
  const title =
    notice.kind === "success"
      ? `${notice.storeName} checkout succeeded`
      : notice.kind === "tested"
        ? `DRY RUN · ${notice.storeName} finished`
        : notice.kind === "alert"
          ? `${notice.storeName} match`
          : notice.kind === "challenge"
            ? `${notice.storeName} needs a person`
            : notice.kind === "session"
              ? `${notice.storeName} needs a sign-in`
              : notice.kind === "drop"
                ? `${notice.sku} drop`
                : notice.kind === "health"
                  ? "Daily health report"
                  : notice.kind === "blocked"
                  ? `${notice.storeName} blocked`
                  : notice.kind === "paused"
                  ? `${notice.storeName} needs attention`
                  : `${notice.storeName} checkout failed`
  const lines = [
    `Product: ${notice.sku}`,
    `Profile: ${notice.profileName}`,
    redact(notice.detail)
  ]
  if (notice.price !== null && notice.price !== undefined) lines.push(`Price: $${notice.price.toFixed(2)}`)
  if (notice.inStock !== undefined) lines.push(`Stock: ${notice.inStock ? "in stock" : "out of stock"}`)
  if (notice.url) lines.push(notice.url)
  if (notice.orderId) lines.push(`Order: ${notice.orderId}`)
  if (notice.kind === "paused" && notice.profileName !== "Alerts") {
    lines.push("Update the account session in Zzz AIO, then resume the task.")
  }
  if (notice.kind === "challenge") {
    lines.push("What to do: clear the check in the window on your PC, or tap the phone alert. The task resumes on its own.")
    lines.push("A person solves this in Zzz AIO. It is not sent to a solving service.")
  }
  if (notice.kind === "session") {
    lines.push("Open the account browser and sign in again. Zzz AIO does not create a session for you.")
  }
  if (notice.kind === "drop") {
    lines.push("Times are Eastern Time.")
  }
  if (notice.kind === "tested") {
    lines.push("DRY RUN: place order was simulated and never sent.")
  }
  return {
    embeds: [
      {
        title,
        description: lines.join("\n").slice(0, 1800),
        color,
        url: notice.url || undefined,
        thumbnail: notice.imageUrl ? { url: notice.imageUrl } : undefined,
        author: BRAND_AUTHOR,
        footer: BRAND_FOOTER
      }
    ]
  }
}

export async function postDiscord(webhook: string, notice: Notice, http: HttpClient = defaultHttp, mention = ""): Promise<void> {
  assertDiscordWebhook(webhook)
  if (!webhook.trim()) return
  await deliver(webhook, withPing(buildDiscordBody(notice), notice, mention), http)
}

/** 0.2.40: a challenge that needs a person pings the configured mention (only that mention may notify). */
export function withPing<T extends { embeds: Array<Record<string, unknown>> }>(body: T, notice: Pick<Notice, "kind" | "storeName">, mention: string): T & { content?: string; allowed_mentions?: Record<string, unknown> } {
  const tag = mention.trim()
  if (notice.kind !== "challenge" || !tag) return body
  const allowed = tag === "@here" || tag === "@everyone"
    ? { parse: ["everyone"] }
    : tag.startsWith("<@&")
      ? { roles: [tag.replace(/\D/g, "")] }
      : { users: [tag.replace(/\D/g, "")] }
  return { ...body, content: `${tag} ${notice.storeName} needs you to clear a check.`, allowed_mentions: allowed }
}

export function shouldPostGroup(settings: Pick<Settings, "groupDiscord" | "groupWebhook">, notice: Notice): boolean {
  if (settings.groupDiscord !== true || !settings.groupWebhook.trim()) return false
  if (notice.kind === "success") return true
  return notice.kind === "alert" && notice.inStock === true
}

export function groupNotice(notice: Notice): Notice {
  const detail = redact(stripPrivate(notice.detail)).slice(0, 400)
  return {
    kind: notice.kind,
    storeName: stripPrivate(notice.storeName).slice(0, 80),
    sku: stripPrivate(notice.sku).slice(0, 120),
    profileName: "",
    detail,
    price: typeof notice.price === "number" && Number.isFinite(notice.price) ? notice.price : undefined,
    url: notice.url?.startsWith("https://") ? notice.url : undefined,
    imageUrl: notice.imageUrl?.startsWith("https://") ? notice.imageUrl : undefined,
    inStock: notice.inStock,
    orderId: notice.orderId ? notice.orderId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) : undefined
  }
}

export function buildGroupBody(notice: Notice): { embeds: Array<Record<string, unknown>> } {
  const safe = groupNotice(notice)
  const title = safe.kind === "success" ? `${safe.storeName} checkout succeeded` : `${safe.storeName} restock`
  const lines = [`Product: ${safe.sku}`, safe.detail]
  if (typeof safe.price === "number") lines.push(`Price: $${safe.price.toFixed(2)}`)
  if (safe.inStock !== undefined) lines.push(`Stock: ${safe.inStock ? "in stock" : "out of stock"}`)
  if (safe.url) lines.push(safe.url)
  if (safe.orderId) lines.push(`Order: ${safe.orderId}`)
  if (safe.kind === "success") lines.push("Profile, email, card, and proxy details are not included.")
  return {
    embeds: [
      {
        title,
        description: lines.filter(Boolean).join("\n").slice(0, 1800),
        color: safe.kind === "success" ? 0x3cba8b : 0x6aa6ff,
        url: safe.url,
        thumbnail: safe.imageUrl ? { url: safe.imageUrl } : undefined,
        author: BRAND_AUTHOR,
        footer: BRAND_FOOTER
      }
    ]
  }
}

export async function postGroupDiscord(settings: Pick<Settings, "groupDiscord" | "groupWebhook">, notice: Notice, http: HttpClient = defaultHttp): Promise<boolean> {
  if (!shouldPostGroup(settings, notice)) return false
  assertDiscordWebhook(settings.groupWebhook)
  await deliver(settings.groupWebhook, buildGroupBody(notice), http)
  return true
}

/** One webhook post at a time, so a burst of alerts queues instead of tripping Discord's rate limit. */
let discordQueue: Promise<unknown> = Promise.resolve()

/** Seconds Discord asked us to wait (429), from the JSON body or Retry-After header. Capped at 10s. */
export function retryAfterMs(response: { headers: Record<string, string | string[] | undefined>; body: string }): number {
  let seconds = Number.NaN
  try {
    seconds = Number((JSON.parse(response.body) as { retry_after?: number }).retry_after)
  } catch {
    // Not JSON.
  }
  if (!Number.isFinite(seconds)) {
    const header = response.headers["retry-after"] ?? response.headers["Retry-After"]
    seconds = Number(Array.isArray(header) ? header[0] : header)
  }
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 1
  return Math.min(10_000, Math.ceil(seconds * 1000))
}

function deliver(webhook: string, body: { embeds: Array<Record<string, unknown>>; content?: string }, http: HttpClient, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<void> {
  const run = discordQueue.then(() => deliverNow(webhook, body, http, wait))
  discordQueue = run.catch(() => undefined)
  return run
}

async function deliverNow(webhook: string, body: { embeds: Array<Record<string, unknown>>; content?: string }, http: HttpClient, wait: (ms: number) => Promise<void>): Promise<void> {
  let response = await http.request({
    method: "POST",
    url: webhook.trim(),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 10000
  })
  for (let attempt = 0; response.status === 429 && attempt < 3; attempt += 1) {
    await wait(retryAfterMs(response))
    response = await http.request({ method: "POST", url: webhook.trim(), headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeoutMs: 10000 })
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AppError(`Discord returned ${response.status}.`)
  }
}

function stripPrivate(value: string): string {
  return value
    .replace(/\b[\w.-]+:[^\s@]+@[^\s]+/g, "[proxy]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\bpassword\s*[:=]?\s*\S+/gi, "password [redacted]")
}

/** Settings > Discord > Test: one sample of every event that is switched on. */
export function sampleNotices(settings: { notifyInStock?: boolean; notifySuccess?: boolean; notifyFailed?: boolean; notifyChallenge?: boolean; notifyDryRun?: boolean }): Notice[] {
  const base = { storeName: "Target", sku: "88897904", profileName: "Home" }
  const out: Notice[] = []
  if (settings.notifyInStock !== false) out.push({ ...base, kind: "instock", detail: "Pokémon TCG: Prismatic Evolutions Elite Trainer Box is in stock (sample).", price: 49.99, inStock: true, url: "https://www.target.com/p/-/A-88897904" })
  if (settings.notifySuccess !== false) out.push({ ...base, kind: "success", detail: "Order 100200300 (sample).", orderId: "100200300", price: 49.99 })
  if (settings.notifyFailed !== false) out.push({ ...base, kind: "failure", detail: "Card declined (sample)." })
  if (settings.notifyChallenge !== false) out.push({ ...base, kind: "challenge", detail: "Target presented a challenge (sample)." })
  if (settings.notifyDryRun !== false) out.push({ ...base, kind: "tested", detail: "DRY RUN passed · 6 pass · 1 skip · place order simulated, not sent (sample)." })
  return out
}
