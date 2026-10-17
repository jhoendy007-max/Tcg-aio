import { digitsOnly, expiryInFuture, last4, luhnOk, normalizeExp } from "../shared/card"
import { AppError } from "../shared/errors"
import { isStoreId } from "../shared/stores"
import { assertDiscordWebhook } from "./discord"
import type { Address, Settings } from "../shared/types"
import { DEFAULT_SETTINGS } from "../shared/types"

const STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "IA", "ID", "IL", "IN", "KS",
  "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE", "NH", "NJ", "NM", "NV",
  "NY", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY"
])

export function cleanAddress(input: Address, label: string): Address {
  const address: Address = {
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    line1: input.line1.trim(),
    line2: (input.line2 ?? "").trim(),
    city: input.city.trim(),
    state: input.state.trim().toUpperCase(),
    zip: input.zip.trim(),
    country: "US"
  }
  if (!address.firstName || !address.lastName) throw new AppError(`${label} name is required.`)
  if (!address.line1) throw new AppError(`${label} street address is required.`)
  if (!address.city) throw new AppError(`${label} city is required.`)
  if (!STATES.has(address.state)) throw new AppError(`${label} state must be a two-letter US code.`)
  if (!/^\d{5}(?:-\d{4})?$/.test(address.zip)) throw new AppError(`${label} ZIP must be 5 digits.`)
  return address
}

export function cleanPhone(phone: string): string {
  const digits = digitsOnly(phone)
  if (digits.length < 10 || digits.length > 15) throw new AppError("Enter a phone number with at least 10 digits.")
  return digits
}

export function cleanEmail(email: string): string {
  const value = email.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new AppError("Enter a valid email address.")
  return value
}

export function cleanCard(input: { cardName: string; cardNumber: string; expMonth: string; expYear: string; cvv: string }, fallbackName: string) {
  const number = digitsOnly(input.cardNumber)
  if (!luhnOk(number)) throw new AppError("Card number failed validation.")
  const exp = normalizeExp(input.expMonth, input.expYear)
  if (!exp || !expiryInFuture(exp.expMonth, exp.expYear)) throw new AppError("Card expiration must be a future month.")
  const cvv = digitsOnly(input.cvv)
  if (!/^\d{3,4}$/.test(cvv)) throw new AppError("CVV must be 3 or 4 digits.")
  const name = input.cardName.trim() || fallbackName
  if (!name) throw new AppError("Name on card is required.")
  return { number, cvv, ...exp, name, last4: last4(number) }
}

export function cleanSettings(input: Settings): Settings {
  const monitorDelayMs = Math.round(Number(input.monitorDelayMs))
  if (!Number.isFinite(monitorDelayMs) || monitorDelayMs < 1000 || monitorDelayMs > 60000) {
    throw new AppError("Monitor delay must be between 1000 and 60000 ms.")
  }
  assertDiscordWebhook(input.discordWebhook ?? "")
  const targetStoreId = (input.targetStoreId || DEFAULT_SETTINGS.targetStoreId).trim()
  const targetZip = (input.targetZip || DEFAULT_SETTINGS.targetZip).trim()
  const targetState = (input.targetState || DEFAULT_SETTINGS.targetState).trim().toUpperCase()
  const targetApiKey = (input.targetApiKey ?? "").trim()
  if (!/^\d{3,6}$/.test(targetStoreId)) throw new AppError("Target store ID must be numeric.")
  if (!/^\d{5}$/.test(targetZip)) throw new AppError("Target ZIP must be 5 digits.")
  if (!STATES.has(targetState)) throw new AppError("Target state must be a two-letter US code.")
  if (targetApiKey && !/^[A-Za-z0-9]{20,80}$/.test(targetApiKey)) {
    throw new AppError("Target API key should be the site key, or left blank to use the built-in key.")
  }
  const challengeTimeoutSec = Math.round(Number(input.challengeTimeoutSec ?? DEFAULT_SETTINGS.challengeTimeoutSec))
  if (!Number.isFinite(challengeTimeoutSec) || challengeTimeoutSec < 30 || challengeTimeoutSec > 600) {
    throw new AppError("Challenge timeout must be between 30 and 600 seconds.")
  }
  const sessionWarmupMin = Math.round(Number(input.sessionWarmupMin ?? DEFAULT_SETTINGS.sessionWarmupMin))
  if (!Number.isFinite(sessionWarmupMin) || sessionWarmupMin < 10 || sessionWarmupMin > 240) {
    throw new AppError("Session warm-up interval must be between 10 and 240 minutes.")
  }
  const monitorJitterPct = Math.round(Number(input.monitorJitterPct ?? DEFAULT_SETTINGS.monitorJitterPct))
  if (!Number.isFinite(monitorJitterPct) || monitorJitterPct < 0 || monitorJitterPct > 40) {
    throw new AppError("Monitor jitter must be between 0 and 40 percent.")
  }
  const blockRetries = Math.round(Number(input.blockRetries ?? DEFAULT_SETTINGS.blockRetries))
  if (!Number.isInteger(blockRetries) || blockRetries < 1 || blockRetries > 8) {
    throw new AppError("Block retries must be from 1 to 8.")
  }
  const monitorFastDelayMs = Math.round(Number(input.monitorFastDelayMs ?? DEFAULT_SETTINGS.monitorFastDelayMs))
  if (!Number.isFinite(monitorFastDelayMs) || monitorFastDelayMs < 250 || monitorFastDelayMs > 60000) {
    throw new AppError("Fast monitor delay must be from 250 to 60000 ms.")
  }
  const dropWindows = (input.dropWindows ?? "").trim()
  if (dropWindows) parseWindowLines(dropWindows)
  const monitorZips = cleanZipList(input.monitorZips ?? "")
  const monitorStoreIds = cleanStoreIdList(input.monitorStoreIds ?? "")
  return {
    discordWebhook: input.discordWebhook.trim(),
    monitorDelayMs,
    targetStoreId,
    targetZip,
    targetState,
    targetApiKey,
    phoneRelayUrl: cleanRelayUrl(input.phoneRelayUrl ?? ""),
    testMode: input.testMode === true,
    clearCartAfterTest: input.clearCartAfterTest === true,
    challengeTimeoutSec,
    sessionWarmup: input.sessionWarmup === true,
    sessionWarmupMin,
    monitorJitterPct,
    blockRetries,
    monitorFastDelayMs,
    dropWindows,
    monitorZips,
    monitorStoreIds,
    alertPrice: input.alertPrice !== false,
    alertNewOffer: input.alertNewOffer !== false,
    alertAvailable: input.alertAvailable !== false,
    alertRetailer: input.alertRetailer !== false,
    autopilot: input.autopilot === true,
    autopilotPriceCap: cleanMoney(input.autopilotPriceCap, "Autopilot price cap"),
    stuckMinutes: cleanRange(input.stuckMinutes, 5, 120, "Stuck task restart"),
    launchOnBoot: input.launchOnBoot === true,
    resumeOnLaunch: input.resumeOnLaunch !== false,
    relaunchOnCrash: input.relaunchOnCrash !== false,
    dailyBudget: cleanMoney(input.dailyBudget, "Daily budget"),
    dropBudget: cleanMoney(input.dropBudget, "Drop budget"),
    maxPerSku: cleanCount(input.maxPerSku, "Max per SKU"),
    maxPerAccount: cleanCount(input.maxPerAccount, "Max per account"),
    storePurchaseLimits: cleanStoreLimits(input.storePurchaseLimits ?? ""),
    healthReportTime: cleanClock(input.healthReportTime ?? ""),
    healthReportZone: cleanZone(input.healthReportZone ?? ""),
    theme: input.theme === "light" ? "light" : "dark",
    accent: input.accent === "blue" || input.accent === "green" || input.accent === "rose" ? input.accent : "gold",
    appName: cleanAppName(input.appName),
    logoDataUrl: cleanLogo(input.logoDataUrl),
    successSound: input.successSound === true,
    taskView: input.taskView === "compact" ? "compact" : "detailed",
    wizardDone: input.wizardDone === true
  }
}

function cleanAppName(value: string | undefined): string {
  const name = (value ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 24)
  return name || "TCGAIO"
}

function cleanLogo(value: string | undefined): string {
  const logo = (value ?? "").trim()
  if (!logo) return ""
  if (logo.length > 120_000) throw new AppError("The logo image is too large. Use a file under about 80 KB.")
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) {
    throw new AppError("The logo has to be a PNG, JPEG, or WebP image.")
  }
  return logo
}

export function cleanImageUrl(value: string | undefined): string {
  const url = (value ?? "").trim()
  if (!url) return ""
  if (url.length > 400 || !/^https:\/\/[^\s]+$/i.test(url)) throw new AppError("Product image URL must be an https link.")
  return url
}

function cleanMoney(value: number, label: string): number {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new AppError(`${label} must be from 0 to 100000. 0 means no cap.`)
  return Math.round(amount * 100) / 100
}

function cleanRange(value: number, min: number, max: number, label: string): number {
  const amount = Math.round(Number(value))
  if (!Number.isInteger(amount) || amount < min || amount > max) throw new AppError(`${label} must be from ${min} to ${max} minutes.`)
  return amount
}

function cleanCount(value: number, label: string): number {
  const amount = Math.round(Number(value ?? 0))
  if (!Number.isInteger(amount) || amount < 0 || amount > 99) throw new AppError(`${label} must be from 0 to 99. 0 means no cap.`)
  return amount
}

function cleanClock(value: string): string {
  const time = value.trim()
  if (!time) return ""
  const match = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!match) throw new AppError("Health report time uses 24-hour HH:MM in your timezone.")
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new AppError("Health report time uses 24-hour HH:MM in your timezone.")
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

function cleanZone(value: string): string {
  const zone = value.trim()
  if (!zone) return ""
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone }).format(0)
  } catch {
    throw new AppError("Health report timezone must be an IANA name like America/New_York, or blank.")
  }
  return zone
}

function cleanStoreLimits(value: string): string {
  const lines: string[] = []
  for (const raw of value.split(/\n+/)) {
    const line = raw.trim()
    if (!line) continue
    const match = /^([a-z0-9-]+)\s*[:=]\s*(\d+)$/i.exec(line)
    if (!match || !isStoreId(match[1]) || Number(match[2]) < 1 || Number(match[2]) > 99) {
      throw new AppError("Store purchase limits use lines like target:1.")
    }
    lines.push(`${match[1].toLowerCase()}:${Number(match[2])}`)
  }
  return lines.join("\n")
}

function parseWindowLines(text: string): void {
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim()
    if (!line) continue
    const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(line)
    if (!match) throw new AppError("Drop windows use Atlantic Time like 09:00-09:30, one per line.")
    const startH = Number(match[1])
    const startM = Number(match[2])
    const endH = Number(match[3])
    const endM = Number(match[4])
    if (startH > 23 || endH > 23 || startM > 59 || endM > 59 || startH * 60 + startM === endH * 60 + endM) {
      throw new AppError("Drop windows use Atlantic Time like 09:00-09:30, one per line.")
    }
  }
}

function cleanZipList(value: string): string {
  const zips = value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)
  for (const zip of zips) {
    if (!/^\d{5}(?:-\d{4})?$/.test(zip)) throw new AppError("Monitor ZIPs must be 5-digit US ZIPs.")
  }
  return zips.join(", ")
}

function cleanStoreIdList(value: string): string {
  const ids = value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)
  for (const id of ids) {
    if (!/^\d{3,8}$/.test(id)) throw new AppError("Monitor store ids must be 3 to 8 digits.")
  }
  return ids.join(", ")
}

export function cleanRelayUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ""
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new AppError("Phone relay must be a ws:// or wss:// URL.")
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new AppError("Phone relay must be a ws:// or wss:// URL.")
  if (url.username || url.password) throw new AppError("Put the phone relay token in the path, not the URL userinfo.")
  return url.toString()
}

export function assertStore(value: string) {
  if (!isStoreId(value)) throw new AppError("Choose a store.")
  return value
}
