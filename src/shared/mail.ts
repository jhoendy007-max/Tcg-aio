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
  bandai: ["p-bandai.com", "bandai.com"],
  gamestop: ["gamestop.com"],
  "barnes-noble": ["barnesandnoble.com", "bn.com"],
  costco: ["costco.com"],
  sams: ["samsclub.com"],
  tcgplayer: ["tcgplayer.com"]
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

const PROVIDER_DOMAINS: Record<string, Exclude<MailProvider, "custom">> = {
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "outlook.com": "outlook",
  "hotmail.com": "outlook",
  "live.com": "outlook",
  "msn.com": "outlook",
  "office365.com": "outlook",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
  "yahoo.com": "yahoo",
  "ymail.com": "yahoo",
  "rocketmail.com": "yahoo"
}

export interface DetectedMailbox {
  provider: MailProvider
  host: string
  port: number
  secure: boolean
  user: string
  guessed: boolean
}

/** Fill host, port, and SSL from the email domain. An unknown domain guesses imap.that-domain on port 993. */
export function detectMailbox(email: string): DetectedMailbox | null {
  const user = email.trim()
  const at = user.lastIndexOf("@")
  if (at <= 0 || at === user.length - 1) return null
  if (/\s/.test(user)) return null
  const domain = user.slice(at + 1).toLowerCase().replace(/\.$/, "")
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null
  const known = PROVIDER_DOMAINS[domain]
  if (known) {
    const preset = MAIL_PRESETS[known]
    return { provider: known, host: preset.host, port: preset.port, secure: preset.secure, user, guessed: false }
  }
  return { provider: "custom", host: `imap.${domain}`, port: 993, secure: true, user, guessed: true }
}

export interface MailGuideLink {
  label: string
  href: string
}

const HELP_HOSTS = new Set([
  "appleid.apple.com",
  "login.yahoo.com",
  "myaccount.google.com",
  "mail.google.com",
  "account.microsoft.com",
  "account.live.com",
  "console.cloud.google.com",
  "portal.azure.com"
])

export function isMailHelpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && HELP_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

export function isOAuthUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && (url.hostname === "accounts.google.com" || url.hostname === "login.microsoftonline.com")
  } catch {
    return false
  }
}

export type MailLang = "en" | "es"

/** A sentence a person can act on. Raw server text is not shown when it can be recognized. */
export function explainMailFailure(raw: string, provider: MailProvider, lang: MailLang = "en"): string {
  const text = raw.replace(/\s+/g, " ").trim()
  const lower = text.toLowerCase()
  const es = lang === "es"
  if (/password was not sent|starttls/.test(lower)) {
    return es
      ? "El servidor no ofreció STARTTLS. La contraseña no se envió. Activa SSL/TLS o usa el puerto 993."
      : "The server did not offer STARTTLS. The password was not sent. Turn on SSL/TLS or use port 993."
  }
  if (/invalid_grant|token has been expired|revoked/.test(lower)) {
    return es
      ? "El inicio de sesión caducó. Vuelve a entrar con Google o Microsoft."
      : "That sign-in expired. Sign in with Google or Microsoft again."
  }
  if (/access_denied|cancelled|canceled|consent/.test(lower) && /sign-in|oauth|denied|cancel/.test(lower)) {
    return es ? "El inicio de sesión se canceló antes de terminar." : "The sign-in was cancelled before it finished."
  }
  if (/client id|client_id|not set up/.test(lower)) {
    return provider === "outlook"
      ? (es ? "Falta el ID de cliente de Microsoft en Ajustes, en este PC. También puedes usar una contraseña de aplicación." : "Microsoft sign-in needs a desktop client ID in Settings on this PC. An app password works too.")
      : (es ? "Falta el ID de cliente de Google en Ajustes, en este PC. También puedes usar una contraseña de aplicación." : "Google sign-in needs a desktop client ID in Settings on this PC. An app password works too.")
  }
  if (/enotfound|getaddrinfo|not known|eai_again/.test(lower)) {
    return es ? "No se encontró ese servidor de correo. Revisa el correo y el servidor." : "That mail server name could not be found. Check the email address and the host."
  }
  if (/econnrefused|connection refused/.test(lower)) {
    return es ? "El servidor rechazó la conexión. Prueba el puerto 993 con SSL/TLS activado." : "The mail server refused the connection. Try port 993 with SSL/TLS on."
  }
  if (/certificate|unable_to_verify|self signed|self-signed/.test(lower)) {
    return es ? "El certificado del servidor no es de confianza. La contraseña no se envió." : "The mail server certificate was not trusted. The password was not sent."
  }
  if (/timed out|timeout|etimedout/.test(lower)) {
    return es ? "El servidor no respondió a tiempo. Revisa el puerto y si SSL/TLS está activado." : "The mail server did not answer in time. Check the port and whether SSL/TLS is on."
  }
  if (/authenticationfailed|invalid credentials|refused the login|login failed|no \[|authenticate failed|bad username/.test(lower)) {
    if (provider === "gmail" || provider === "outlook") {
      return es
        ? "El servidor rechazó el acceso. Usa Iniciar sesión, o una contraseña de aplicación, no la contraseña de la cuenta."
        : "The mail server refused the login. Use Sign in, or an app password, not the account password."
    }
    if (provider === "icloud" || provider === "yahoo") {
      return es
        ? "El servidor rechazó el acceso. Usa una contraseña de aplicación, no la contraseña de la cuenta. El usuario es el correo completo."
        : "The mail server refused the login. Use an app password, not the account password. The username is the full email address."
    }
    return es
      ? "El servidor rechazó el usuario o la contraseña. Revisa ambos y que SSL/TLS coincida con el puerto."
      : "The mail server refused the username or password. Check both, and that SSL/TLS matches the port."
  }
  if (/could not be opened|mailbox/.test(lower) && /select|open|mailbox/.test(lower)) {
    return es ? "Esa carpeta no existe. Elige INBOX u otra carpeta de la lista." : "That folder could not be opened. Choose INBOX or another folder from the list."
  }
  if (!text) return es ? "No se pudo conectar el correo." : "Mail could not be connected."
  const clipped = text.replace(/bearer\s+\S+/gi, "Bearer …").slice(0, 160)
  return es ? `No se pudo conectar el correo. ${clipped}` : `Mail could not be connected. ${clipped}`
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
