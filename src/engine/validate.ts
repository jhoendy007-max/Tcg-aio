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
    challengeTimeoutSec
  }
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
