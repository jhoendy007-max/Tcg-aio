import { AppError } from "../shared/errors"
import { redact } from "../shared/redact"
import type { Notice } from "../shared/types"
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

export function buildDiscordBody(notice: Notice): { embeds: Array<Record<string, unknown>> } {
  const color = notice.kind === "success"
    ? 0x3cba8b
    : notice.kind === "tested" || notice.kind === "alert"
      ? 0x6aa6ff
      : notice.kind === "drop" || notice.kind === "health"
        ? 0x6aa6ff
        : notice.kind === "paused" || notice.kind === "challenge" || notice.kind === "session"
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
    lines.push("Update the account session in TCGAIO, then resume the task.")
  }
  if (notice.kind === "challenge") {
    lines.push("A person solves this in TCGAIO. It is not sent to a solving service.")
  }
  if (notice.kind === "session") {
    lines.push("Open the account browser and sign in again. TCGAIO does not create a session for you.")
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
        thumbnail: notice.imageUrl ? { url: notice.imageUrl } : undefined
      }
    ]
  }
}

export async function postDiscord(webhook: string, notice: Notice, http: HttpClient = defaultHttp): Promise<void> {
  assertDiscordWebhook(webhook)
  if (!webhook.trim()) return
  const response = await http.request({
    method: "POST",
    url: webhook.trim(),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildDiscordBody(notice)),
    timeoutMs: 10000
  })
  if (response.status < 200 || response.status >= 300) {
    throw new AppError(`Discord returned ${response.status}.`)
  }
}
