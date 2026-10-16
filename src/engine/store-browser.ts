import { app, BrowserWindow, session, type Session } from "electron"
import { pageLooksLikeChallenge, type SessionRefreshRequest, type SessionRefreshResult } from "./block-recovery"
import { parseSession } from "./session"
import type { ProxyEndpoint, SessionCookies } from "../shared/types"

const CHALLENGE_WAIT_MS = 3 * 60 * 1000
const pendingProxy = new Map<number, ProxyEndpoint>()
const hooked = new Set<string>()
const mainStatus = new Map<string, number>()

let loginHooked = false

function hookLogin(): void {
  if (loginHooked) return
  loginHooked = true
  app.on("login", (event, webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return
    const proxy = pendingProxy.get(webContents.id)
    if (!proxy?.username) return
    event.preventDefault()
    callback(proxy.username, proxy.password ?? "")
  })
}

/**
 * Reload the store in the account's persistent Chromium partition, through the
 * proxy the task just selected. The only cookies written in are ones already
 * saved on the account. New cookies are copied from what the site itself sets.
 * A challenge page is shown for a person to solve. This does not forge cookies
 * or call a solver.
 */
export async function refreshStoreSession(input: SessionRefreshRequest): Promise<SessionRefreshResult> {
  hookLogin()
  const partition = `persist:tcgaio-${input.store}-${input.accountId}`
  const browser = session.fromPartition(partition)
  watchMainFrame(partition, browser)
  mainStatus.set(partition, 0)
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
  if (input.proxy) pendingProxy.set(win.webContents.id, input.proxy)
  let closed = false
  win.on("closed", () => {
    closed = true
  })
  try {
    await loadHome(win, input.homeUrl, input.signal)
    let challenged = !closed && await challengeVisible(win, partition)
    if (challenged && !closed && !input.signal.aborted) {
      win.setTitle("TCGAIO · Solve the store check")
      win.show()
      win.focus()
      input.onChallenge("The store is showing a check in the browser window on this PC. Solve it there and the task will continue. TCGAIO does not send challenges to a solving service.")
      await waitUntilClear(win, partition, input.signal)
      challenged = closed || input.signal.aborted || await challengeVisible(win, partition)
    }
    return { cookies: await readSiteCookies(browser, input.homeUrl), challenged }
  } finally {
    pendingProxy.delete(win.webContents.id)
    if (!win.isDestroyed()) win.destroy()
  }
}

function watchMainFrame(partition: string, browser: Session): void {
  if (hooked.has(partition)) return
  hooked.add(partition)
  browser.webRequest.onCompleted({ urls: ["<all_urls>"] }, (details) => {
    if (details.resourceType === "mainFrame") mainStatus.set(partition, details.statusCode)
  })
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

async function challengeVisible(win: BrowserWindow, partition: string): Promise<boolean> {
  if (win.isDestroyed()) return false
  const status = mainStatus.get(partition) ?? 0
  if (status === 403 || status === 412 || status === 429 || status === 435) return true
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

async function waitUntilClear(win: BrowserWindow, partition: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + CHALLENGE_WAIT_MS
  while (Date.now() < deadline && !signal.aborted && !win.isDestroyed()) {
    await delay(2000, signal)
    if (!await challengeVisible(win, partition)) return
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    function finish() {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function abortError(): Error {
  const err = new Error("The task was stopped.")
  err.name = "AbortError"
  return err
}
