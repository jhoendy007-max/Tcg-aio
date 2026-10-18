import { app, BrowserWindow, session, type Session } from "electron"
import { pageLooksLikeChallenge, type SessionRefreshRequest, type SessionRefreshResult } from "./block-recovery"
import { otpFillScript } from "./otp"
import { parseSession } from "./session"
import { sessionPartition } from "./session-care"
import type { ProxyEndpoint, SessionCookies } from "../shared/types"

const pendingProxy = new Map<number, ProxyEndpoint>()

/**
 * Reload the store in the account's persistent Chromium partition, through the
 * proxy the task just selected. The only cookies written in are ones already
 * saved on the account. New cookies are copied from what the site itself sets.
 * A challenge page is left for the existing handoff. This does not forge cookies
 * or call a solver.
 */
export async function refreshStoreSession(input: SessionRefreshRequest): Promise<SessionRefreshResult> {
  const browser = session.fromPartition(sessionPartition(input.accountId))
  if (input.existing) await writeCookieHeader(browser, input.homeUrl, cookieHeader(input.existing))
  if (input.proxy) await browser.setProxy({ proxyRules: `http://${input.proxy.host}:${input.proxy.port}` })
  else await browser.setProxy({ mode: "direct" })

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    title: "TCGAIO",
    autoHideMenuBar: true,
    webPreferences: {
      session: browser,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  if (input.proxy?.username) pendingProxy.set(win.webContents.id, input.proxy)
  const onLogin = (event: Electron.Event, webContents: Electron.WebContents, _details: Electron.AuthenticationResponseDetails, authInfo: Electron.AuthInfo, callback: (user?: string, pass?: string) => void) => {
    if (!authInfo.isProxy || webContents.id !== win.webContents.id) return
    const proxy = pendingProxy.get(webContents.id)
    if (!proxy?.username) return
    event.preventDefault()
    callback(proxy.username, proxy.password ?? "")
  }
  app.on("login", onLogin)
  try {
    await loadHome(win, input.homeUrl, input.signal)
    await fillMailboxCode(win, input.lookupCode, input.onMailFilled)
    let challenged = await challengeVisible(win)
    if (challenged) {
      input.onChallenge("The store is showing a check. Solve it in the account browser on this PC. TCGAIO does not send challenges to a solving service.")
      if (input.holdMs && input.holdMs > 0) {
        win.setTitle(`Solve ${safeHost(input.homeUrl)}`)
        win.show()
        challenged = await waitForClear(win, input.signal, input.holdMs)
      }
    }
    return { cookies: await readSiteCookies(browser, input.homeUrl), challenged }
  } finally {
    app.removeListener("login", onLogin)
    pendingProxy.delete(win.webContents.id)
    if (!win.isDestroyed()) win.destroy()
  }
}

async function writeCookieHeader(browser: Session, homeUrl: string, header: string): Promise<void> {
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!name || !value) continue
    await browser.cookies.set({
      url: homeUrl,
      name,
      value,
      path: "/",
      secure: homeUrl.startsWith("https://")
    }).catch(() => undefined)
  }
}

function cookieHeader(existing: SessionCookies): string {
  if (existing.cookie) return existing.cookie
  const parts: string[] = []
  if (existing.accessToken && existing.accessToken !== "session") parts.push(`accessToken=${existing.accessToken}`)
  if (existing.visitorId) parts.push(`visitorId=${existing.visitorId}`)
  if (existing.refreshToken) parts.push(`refreshToken=${existing.refreshToken}`)
  if (existing.idToken) parts.push(`idToken=${existing.idToken}`)
  return parts.join("; ")
}

async function readSiteCookies(browser: Session, homeUrl: string): Promise<SessionCookies> {
  const cookies = await browser.cookies.get({ url: homeUrl })
  const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
  if (!header) return { accessToken: "session" }
  try {
    return { ...parseSession(header), cookie: header }
  } catch {
    return { accessToken: "session", cookie: header }
  }
}

async function loadHome(win: BrowserWindow, homeUrl: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => done(), 20000)
    const done = () => {
      clearTimeout(timer)
      win.webContents.removeListener("did-finish-load", done)
      win.webContents.removeListener("did-fail-load", done)
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    win.webContents.once("did-finish-load", done)
    win.webContents.once("did-fail-load", done)
    signal.addEventListener("abort", onAbort, { once: true })
    void win.loadURL(homeUrl).catch(() => done())
  })
}

async function fillMailboxCode(
  win: BrowserWindow,
  lookup: SessionRefreshRequest["lookupCode"],
  onFilled: SessionRefreshRequest["onMailFilled"]
): Promise<void> {
  if (!lookup || win.isDestroyed()) return
  let code: string | null = null
  try {
    code = await lookup()
  } catch {
    code = null
  }
  if (!code || !/^\d{4,8}$/.test(code)) return
  try {
    const filled = await win.webContents.executeJavaScript(otpFillScript(code), true)
    if (filled === true) onFilled?.()
  } catch {
    // The page had no code field.
  }
}

async function challengeVisible(win: BrowserWindow): Promise<boolean> {
  if (win.isDestroyed()) return false
  if (pageLooksLikeChallenge(win.webContents.getURL())) return true
  try {
    const text = await win.webContents.executeJavaScript(
      "(() => { const title = document.title || ''; const body = (document.body && document.body.innerText) || ''; return title + '\\n' + String(body).slice(0, 1500); })()",
      true
    )
    return typeof text === "string" && pageLooksLikeChallenge(text)
  } catch {
    return false
  }
}

async function waitForClear(win: BrowserWindow, signal: AbortSignal, holdMs: number): Promise<boolean> {
  const deadline = Date.now() + holdMs
  while (!signal.aborted && Date.now() < deadline) {
    await waitFor(Math.min(2000, Math.max(200, deadline - Date.now())), signal)
    if (win.isDestroyed()) return true
    if (!(await challengeVisible(win))) return false
  }
  if (signal.aborted) throw abortError()
  return challengeVisible(win)
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return "store"
  }
}

function abortError(): Error {
  const err = new Error("The task was stopped.")
  err.name = "AbortError"
  return err
}
