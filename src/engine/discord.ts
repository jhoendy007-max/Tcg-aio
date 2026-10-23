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
        ? `${notice.storeName} test finished`
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
    lines.push("A person solves this in Zzz AIO. It is not sent to a solving service.")
  }
  if (notice.kind === "session") {
    lines.push("Open the account browser and sign in again. Zzz AIO does not create a session for you.")
  }
  if (notice.kind === "drop") {
    lines.push("Times are Atlantic Time (Puerto Rico, UTC−4).")
  }
  if (notice.kind === "tested") {
    lines.push("Place order was not sent.")
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

export async function postDiscord(webhook: string, notice: Notice, http: HttpClient = defaultHttp): Promise<void> {
  assertDiscordWebhook(webhook)
  if (!webhook.trim()) return
  await deliver(webhook, buildDiscordBody(notice), http)
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

async function deliver(webhook: string, body: { embeds: Array<Record<string, unknown>> }, http: HttpClient): Promise<void> {
  const response = await http.request({
    method: "POST",
    url: webhook.trim(),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 10000
  })
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
