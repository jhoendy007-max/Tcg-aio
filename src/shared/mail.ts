import type { StoreId } from "./types"

export const MAIL_PROVIDERS = ["gmail", "outlook", "icloud", "yahoo", "custom"] as const

export type MailProvider = (typeof MAIL_PROVIDERS)[number]

export interface MailPreset {
  host: string
  port: number
  secure: boolean
  guidance: string
}

export const MAIL_PRESETS: Record<Exclude<MailProvider, "custom">, MailPreset> = {
  gmail: {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    guidance: "Google Account, Security, 2-Step Verification, App passwords. Paste that 16-character app password. Turn IMAP on in Gmail settings."
  },
  outlook: {
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    guidance: "Microsoft account, Security, Advanced security options, App passwords. Use the app password when the account allows one."
  },
  icloud: {
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    guidance: "appleid.apple.com, Sign-In and Security, App-Specific Passwords. The username is the full iCloud email address."
  },
  yahoo: {
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    guidance: "Yahoo Account Security, Generate app password. The username is the full Yahoo email address."
  }
}

export const CUSTOM_MAIL_GUIDANCE = "Use the hostname and port from your provider. SSL/TLS on uses port 993. Off uses STARTTLS and will not send the password unless the server upgrades."

/** Domains a store uses to send the user's own mail. A message counts only when From matches one of these. */
export const STORE_SENDERS: Record<StoreId, readonly string[]> = {
  target: ["target.com", "oe.target.com", "em.target.com"],
  walmart: ["walmart.com", "em.walmart.com"],
  bestbuy: ["bestbuy.com", "email.bestbuy.com"],
  "pokemon-center": ["pokemoncenter.com", "email.pokemon.com", "pokemon.com"],
  amazon: ["amazon.com"],
  crunchyroll: ["crunchyroll.com", "store.crunchyroll.com"],
  bandai: ["p-bandai.com", "bandai.com"]
}

export function isMailProvider(value: string): value is MailProvider {
  return (MAIL_PROVIDERS as readonly string[]).includes(value)
}

export function providerForHost(host: string): MailProvider {
  const name = host.trim().toLowerCase()
  for (const provider of MAIL_PROVIDERS) {
    if (provider === "custom") continue
    if (MAIL_PRESETS[provider].host === name) return provider
  }
  return "custom"
}

export function presetGuidance(provider: MailProvider): string {
  if (provider === "custom") return CUSTOM_MAIL_GUIDANCE
  return MAIL_PRESETS[provider].guidance
}

export function senderDomain(from: string): string {
  const match = from.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i)
  return (match?.[1] ?? "").toLowerCase().replace(/\.$/, "")
}

export function domainAllowed(domain: string, allowed: readonly string[]): boolean {
  const host = domain.toLowerCase().replace(/\.$/, "")
  if (!host) return false
  return allowed.some((item) => host === item || host.endsWith(`.${item}`))
}

export function senderMatchesStore(from: string, store: StoreId): boolean {
  return domainAllowed(senderDomain(from), STORE_SENDERS[store] ?? [])
}

export function storeForSender(from: string): StoreId | null {
  const domain = senderDomain(from)
  for (const store of Object.keys(STORE_SENDERS) as StoreId[]) {
    if (domainAllowed(domain, STORE_SENDERS[store])) return store
  }
  return null
}

const CODE_AFTER = /(?:\b(?:verification|one[-\s]?time|security|login|sign[-\s]?in|otp|passcode|auth(?:entication)?)\b)[^\d]{0,48}(\d{4,8})\b/gi
const CODE_BEFORE = /\b(\d{4,8})\b[^\d]{0,24}(?:\b(?:verification code|one[-\s]?time|security code|otp|passcode)\b)/gi

/** A 4–8 digit code next to verification wording. Prefers 6 digits. Ignores card numbers and tracking numbers. */
export function verificationCode(text: string): string | null {
  const masked = text
    .slice(0, 20_000)
    .replace(/\b(?:\d[ -]?){13,19}\b/g, " ")
    .replace(/\b1Z[0-9A-Z]{16}\b/gi, " ")
    .replace(/\b\d{12,}\b/g, " ")
  const found: string[] = []
  for (const pattern of [CODE_AFTER, CODE_BEFORE]) {
    pattern.lastIndex = 0
    for (const match of masked.matchAll(pattern)) {
      const code = match[1]
      if (!code || code.length < 4 || code.length > 8) continue
      found.push(code)
    }
  }
  return found.find((code) => code.length === 6) ?? found[0] ?? null
}

export function looksLikeRestock(subject: string, text: string): boolean {
  const blob = `${subject}\n${text}`.slice(0, 8_000)
  return /back in stock|restock(?:ed)?|now available|in stock again|available to order|pre[- ]?order (?:is )?open/i.test(blob)
}

export function looksLikeStoreAlert(subject: string, text: string): boolean {
  if (looksLikeRestock(subject, text)) return true
  const blob = `${subject}\n${text}`.slice(0, 8_000)
  return /\bnewsletter\b|\bnew arrival\b|\bjust dropped\b|\bnow live\b/i.test(blob)
}

export function messagesForStore<T extends { from: string; subject: string; text: string }>(messages: T[], store: StoreId): string {
  return messages
    .filter((message) => senderMatchesStore(message.from, store))
    .map((message) => `${message.subject}\n${message.text}`)
    .join("\n")
}

/** Subject line for a phone or Discord alert. Digit runs are masked so a code is not copied out. */
export function mailAlertDetail(subject: string): string {
  const clean = subject.replace(/\d{4,8}/g, "••••").replace(/\s+/g, " ").trim().slice(0, 140)
  return clean ? `Store mail: ${clean}` : "Store mail: restock or newsletter"
}
