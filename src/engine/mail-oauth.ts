import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { Database } from "./database"
import { MAIL_PRESETS, explainMailFailure, isOAuthUrl } from "../shared/mail"
import { AppError } from "../shared/errors"
import type { MailboxView, Settings } from "../shared/types"

export interface OAuthCodeWait {
  redirectUri: string
  done: Promise<string>
  close(): void
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export function mailClientId(provider: "gmail" | "outlook", settings: Settings): string {
  const saved = provider === "gmail" ? settings.googleMailClientId : settings.microsoftMailClientId
  if (saved.trim()) return saved.trim()
  const env = provider === "gmail" ? process.env.TCGAIO_GOOGLE_CLIENT_ID : process.env.TCGAIO_MICROSOFT_CLIENT_ID
  return (env ?? "").trim()
}

export function authorizeUrl(input: {
  provider: "gmail" | "outlook"
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  loginHint: string
}): string {
  const url = input.provider === "gmail"
    ? new URL("https://accounts.google.com/o/oauth2/v2/auth")
    : new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("code_challenge", input.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", input.state)
  if (input.provider === "gmail") {
    url.searchParams.set("scope", "https://mail.google.com/")
    url.searchParams.set("access_type", "offline")
    url.searchParams.set("prompt", "consent")
  } else {
    url.searchParams.set("scope", "offline_access https://outlook.office.com/IMAP.AccessAsUser.All")
    url.searchParams.set("prompt", "select_account")
  }
  if (input.loginHint.includes("@")) url.searchParams.set("login_hint", input.loginHint)
  return url.toString()
}

export function tokenEndpoint(provider: "gmail" | "outlook"): string {
  return provider === "gmail"
    ? "https://oauth2.googleapis.com/token"
    : "https://login.microsoftonline.com/common/oauth2/v2.0/token"
}

export function tokenForm(input: {
  provider: "gmail" | "outlook"
  clientId: string
  code?: string
  refreshToken?: string
  verifier?: string
  redirectUri?: string
}): string {
  const body = new URLSearchParams()
  body.set("client_id", input.clientId)
  if (input.refreshToken) {
    body.set("grant_type", "refresh_token")
    body.set("refresh_token", input.refreshToken)
  } else {
    body.set("grant_type", "authorization_code")
    body.set("code", input.code ?? "")
    body.set("redirect_uri", input.redirectUri ?? "")
    body.set("code_verifier", input.verifier ?? "")
  }
  if (input.provider === "outlook") {
    body.set("scope", "offline_access https://outlook.office.com/IMAP.AccessAsUser.All")
  }
  return body.toString()
}

export function parseTokenBody(status: number, body: string, keepRefresh = ""): { accessToken: string; refreshToken: string; expiresIn: number } {
  let parsed: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown }
  try {
    parsed = JSON.parse(body) as typeof parsed
  } catch {
    throw new Error(`The sign-in service returned HTTP ${status}.`)
  }
  if (status >= 400 || parsed.error) {
    const reason = typeof parsed.error === "string" ? parsed.error : `HTTP ${status}`
    throw new Error(reason)
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) throw new Error("The sign-in did not return a token.")
  const refresh = typeof parsed.refresh_token === "string" && parsed.refresh_token ? parsed.refresh_token : keepRefresh
  if (!refresh) throw new Error("The sign-in did not return a refresh token. Try again and allow offline access.")
  return {
    accessToken: parsed.access_token,
    refreshToken: refresh,
    expiresIn: typeof parsed.expires_in === "number" ? parsed.expires_in : 3600
  }
}

export function listenForOAuthCode(state: string, timeoutMs = 180_000): Promise<OAuthCodeWait> {
  return new Promise((resolve, reject) => {
    let finish = (_err: Error | null, _code?: string) => undefined as void
    const done = new Promise<string>((ok, fail) => {
      finish = (err, code) => {
        if (err) fail(err)
        else if (code) ok(code)
      }
    })
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1")
      res.setHeader("content-type", "text/html; charset=utf-8")
      if (url.pathname !== "/callback") {
        res.statusCode = 404
        res.end("<p>Not found.</p>")
        return
      }
      const error = url.searchParams.get("error")
      const code = url.searchParams.get("code")
      const got = url.searchParams.get("state")
      if (error || !code || got !== state) {
        res.end("<p>Sign-in was not completed. You can close this window.</p>")
        finish(new Error(error === "access_denied" ? "The sign-in was cancelled." : "The sign-in was not completed."))
        return
      }
      res.end("<p>Signed in. You can close this window and return to Zzz AIO.</p>")
      finish(null, code)
    })
    const timer = setTimeout(() => finish(new Error("The sign-in timed out.")), timeoutMs)
    server.once("error", (err) => reject(err))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = address && typeof address === "object" ? address.port : 0
      resolve({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        done,
        close() {
          clearTimeout(timer)
          server.close()
        }
      })
    })
  })
}

type Poster = (url: string, body: string) => Promise<{ status: number; body: string }>

async function defaultPost(url: string, body: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  })
  return { status: response.status, body: await response.text() }
}

export async function refreshAccessToken(input: {
  provider: "gmail" | "outlook"
  clientId: string
  refreshToken: string
  post?: Poster
}): Promise<string> {
  const post = input.post ?? defaultPost
  const response = await post(tokenEndpoint(input.provider), tokenForm({
    provider: input.provider,
    clientId: input.clientId,
    refreshToken: input.refreshToken
  }))
  return parseTokenBody(response.status, response.body, input.refreshToken).accessToken
}

export async function completeMailSignIn(
  db: Database,
  input: { provider: "gmail" | "outlook"; user: string },
  deps: {
    open: (url: string) => Promise<void> | void
    post?: Poster
    listen?: typeof listenForOAuthCode
  }
): Promise<MailboxView> {
  const settings = db.getSettings()
  const clientId = mailClientId(input.provider, settings)
  if (!clientId) throw new AppError(explainMailFailure("client id is not set up", input.provider, settings.language))
  const user = input.user.trim()
  if (!user.includes("@")) throw new AppError(settings.language === "es" ? "Escribe el correo antes de iniciar sesión." : "Enter the email address before signing in.")
  const { verifier, challenge } = pkcePair()
  const state = randomBytes(16).toString("base64url")
  const wait = await (deps.listen ?? listenForOAuthCode)(state)
  try {
    const url = authorizeUrl({
      provider: input.provider,
      clientId,
      redirectUri: wait.redirectUri,
      challenge,
      state,
      loginHint: user
    })
    if (!isOAuthUrl(url)) throw new AppError("Refusing to open that sign-in page.")
    await deps.open(url)
    const code = await wait.done
    const post = deps.post ?? defaultPost
    const exchanged = await post(tokenEndpoint(input.provider), tokenForm({
      provider: input.provider,
      clientId,
      code,
      verifier,
      redirectUri: wait.redirectUri
    }))
    const tokens = parseTokenBody(exchanged.status, exchanged.body)
    return db.saveOAuthMailbox({ user, provider: input.provider, refreshToken: tokens.refreshToken })
  } catch (err) {
    const raw = err instanceof Error ? err.message : "The sign-in was not completed."
    if (err instanceof AppError) throw err
    throw new AppError(explainMailFailure(raw, input.provider, settings.language))
  } finally {
    wait.close()
  }
}

export async function accessTokenFor(db: Database, provider: "gmail" | "outlook", refreshToken: string, post?: Poster): Promise<string> {
  const settings = db.getSettings()
  const clientId = mailClientId(provider, settings)
  if (!clientId) throw new Error(explainMailFailure("client id is not set up", provider, settings.language))
  return refreshAccessToken({ provider, clientId, refreshToken, post })
}

export function presetFor(provider: "gmail" | "outlook"): { host: string; port: number; secure: boolean } {
  return MAIL_PRESETS[provider]
}
