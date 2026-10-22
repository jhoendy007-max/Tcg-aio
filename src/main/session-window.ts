import { app, BrowserWindow, session, type Session, type WebContents } from "electron"
import { chromiumProxyRules } from "../engine/chromium-session"
import type { Database } from "../engine/database"
import { applySolvedCookies, challengePageUrl, cookieHeader, splitCookieHeader } from "../engine/challenge"
import { looksSignedOut, sessionOrigin, sessionPartition, storeHome } from "../engine/session-care"
import type { SessionWindowQueue } from "../shared/consistency"
import { challengeHost } from "../engine/challenge"
import type { FullAccount, ProxyEndpoint } from "../shared/types"

export interface SessionBrowser {
  open(accountId: string): Promise<void>
  capture(accountId: string): Promise<void>
  warm(accountId: string): Promise<{ expired: boolean; detail: string }>
  close(): Promise<void>
}

/**
 * A normal Chromium window per account. The person signs in. TCGAIO reads the
 * cookies that browser stored. It does not generate sensor data or a fingerprint.
 */
export function createSessionBrowser(db: Database, getParent: () => BrowserWindow | null, queue?: SessionWindowQueue): SessionBrowser {
  const windows = new Map<string, BrowserWindow>()
  const unlistens = new Map<string, () => void>()

  async function closeOne(accountId: string): Promise<void> {
    unlistens.get(accountId)?.()
    unlistens.delete(accountId)
    const current = windows.get(accountId)
    windows.delete(accountId)
    if (current && !current.isDestroyed()) current.destroy()
  }

  async function prepare(account: FullAccount, title: string, show: boolean): Promise<{ win: BrowserWindow; ses: Session }> {
    await closeOne(account.id)
    const ses = session.fromPartition(sessionPartition(account.id))
    const proxy = proxyFor(db, account)
    await bindProxy(ses, proxy)
    unlistens.set(account.id, watchProxyLogin(ses, proxy))
    const parent = getParent()
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      show,
      parent: parent ?? undefined,
      title,
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false
      }
    })
    windows.set(account.id, win)
    win.on("closed", () => {
      if (windows.get(account.id) === win) windows.delete(account.id)
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith("https:")) return { action: "deny" }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          parent: win,
          autoHideMenuBar: true,
          webPreferences: {
            session: ses,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false
          }
        }
      }
    })
    await seed(ses, account)
    return { win, ses }
  }

  return {
    async open(accountId) {
      const account = db.readAccount(accountId)
      const { win } = await prepare(account, `Sign in · ${account.label}`, true)
      await win.loadURL(storeHome(account.store))
    },
    async capture(accountId) {
      const account = db.readAccount(accountId)
      const header = await readCookies(account)
      if (!header) throw new Error("The browser has no cookies yet. Sign in, then save the session.")
      db.updateSession(account.id, applySolvedCookies(account.session, header))
      db.markSession(account.id, "saved", false)
    },
    async warm(accountId) {
      const run = () => warmAccount(accountId)
      if (!queue) return run()
      queue.setCap(db.getSettings().sessionWindowCap)
      return queue.run(run)
    },
    async close() {
      for (const id of [...windows.keys()]) await closeOne(id)
    }
  }

  async function warmAccount(accountId: string): Promise<{ expired: boolean; detail: string }> {
      if (windows.has(accountId)) return { expired: false, detail: "The sign-in window is already open." }
      const account = db.readAccount(accountId)
      const { win } = await prepare(account, `Session warm-up · ${account.label}`, true)
      try {
        const homeLoaded = await load(win, storeHome(account.store))
        const task = db.listTasks().find((item) => item.accountId === account.id && item.store === account.store)
        const productLoaded = task ? await load(win, challengePageUrl(account.store, task.sku)) : false
        if (!homeLoaded && !productLoaded) {
          const current = db.listAccounts().find((item) => item.id === account.id)
          db.markSession(account.id, current?.sessionState === "expired" ? "expired" : current?.hasSession ? "saved" : "missing", true)
          return { expired: false, detail: "The store page did not finish loading. The saved session was left as it is." }
        }
        const header = await readCookies(account)
        const finalUrl = win.isDestroyed() ? "" : win.webContents.getURL()
        if (looksSignedOut(finalUrl, header)) {
          db.markSession(account.id, "expired", true)
          return { expired: true, detail: `${account.label} needs a sign-in. Open the account browser and sign in again.` }
        }
        db.updateSession(account.id, applySolvedCookies(account.session, header))
        db.markSession(account.id, "saved", true)
        return { expired: false, detail: `Saved the cookies from the ${account.label} browser.` }
      } finally {
        await closeOne(account.id)
      }
  }
}

function proxyFor(db: Database, account: FullAccount): ProxyEndpoint | undefined {
  const fromAccount = account.proxyGroupId
  const fromTask = db.listTasks().find((task) => task.accountId === account.id)?.proxyGroupId ?? null
  const groupId = fromAccount || fromTask
  if (!groupId) return undefined
  try {
    const group = db.getProxyGroup(groupId)
    return db.assignProxy(account.id, group.id, group.proxies).proxy
  } catch {
    return undefined
  }
}

async function seed(ses: Session, account: FullAccount): Promise<void> {
  const origin = sessionOrigin(account.store)
  for (const cookie of splitCookieHeader(cookieHeader(account.session))) {
    try {
      await ses.cookies.set({
        url: origin,
        name: cookie.name,
        value: cookie.value,
        path: "/",
        secure: true,
        sameSite: "lax"
      })
    } catch {
      // The real site can set the cookie itself when the page loads.
    }
  }
}

async function readCookies(account: FullAccount): Promise<string> {
  const origin = sessionOrigin(account.store)
  const host = challengeHost(account.store)
  const cookies = await session.fromPartition(sessionPartition(account.id)).cookies.get({ url: origin })
  return cookies
    .filter((cookie) => {
      const domain = (cookie.domain ?? "").replace(/^\./, "")
      return domain === host || host.endsWith(`.${domain}`)
    })
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ")
}

function load(win: BrowserWindow, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), 20_000)
    win.webContents.once("did-finish-load", () => finish(true))
    win.webContents.once("did-fail-load", () => finish(false))
    void win.loadURL(url).catch(() => finish(false))
  })
}

async function bindProxy(ses: Session, proxy: ProxyEndpoint | undefined): Promise<void> {
  if (!proxy) {
    await ses.setProxy({ mode: "direct" })
    return
  }
  await ses.setProxy({ proxyRules: chromiumProxyRules(proxy) })
}

function watchProxyLogin(ses: Session, proxy: ProxyEndpoint | undefined): () => void {
  if (!proxy?.username) return () => undefined
  const username = proxy.username
  const password = proxy.password ?? ""
  const listener = (event: Electron.Event, webContents: WebContents, _details: Electron.AuthenticationResponseDetails, authInfo: Electron.AuthInfo, callback: (user?: string, pass?: string) => void) => {
    if (!authInfo.isProxy || webContents.session !== ses) return
    event.preventDefault()
    callback(username, password)
  }
  app.on("login", listener)
  return () => app.removeListener("login", listener)
}
