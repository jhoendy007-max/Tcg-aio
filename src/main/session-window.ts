import { app, BrowserWindow, dialog, session, shell, WebContentsView, type Session, type WebContents } from "electron"
import { chromiumProxyRules } from "../engine/chromium-session"
import type { Database } from "../engine/database"
import { applySolvedCookies, challengePageUrl, cookieHeader, splitCookieHeader } from "../engine/challenge"
import { looksSignedOut, pageShowsStoreError, sessionOrigin, sessionPartition, signInRejectedMessage, storeHome, storeSignInUrl } from "../engine/session-care"
import { forgetProxyBinding } from "./chromium-http"
import { proxyForAccountTask } from "../engine/account-proxy"
import { attachSigninBar, barWindowPreferences, type SigninBar } from "./signin-bar"
import type { SessionWindowQueue } from "../shared/consistency"
import { challengeHost } from "../engine/challenge"
import { pageShowsChallenge } from "../shared/challenge-solved"
import type { FullAccount, ProxyEndpoint } from "../shared/types"

export interface SessionBrowser {
  open(accountId: string, options?: { fresh?: boolean }): Promise<void>
  capture(accountId: string): Promise<void>
  warm(accountId: string, options?: WarmOptions): Promise<WarmResult>
  close(): Promise<void>
}

export interface WarmOptions {
  /** The task asking. Its proxy group decides the proxy, the same one its HTTP path uses. */
  taskId?: string
  /** 0.2.40 keep-warm: hidden window, one normal page load of the signed-in cart page. */
  background?: boolean
}

export interface WarmResult {
  expired: boolean
  detail: string
  /** The store showed a bot check. Keep-warm stops for this account and alerts instead. */
  challenged?: boolean
}

/** Low-rate page a signed-in person would open anyway. */
const KEEP_WARM_URL: Partial<Record<string, string>> = { target: "https://www.target.com/cart" }

/**
 * A normal Chromium window per account. The person signs in. Zzz AIO reads the
 * cookies that browser stored. It does not generate sensor data or a fingerprint.
 */
export function createSessionBrowser(db: Database, getParent: () => BrowserWindow | null, queue?: SessionWindowQueue): SessionBrowser {
  const windows = new Map<string, BrowserWindow>()
  const unlistens = new Map<string, () => void>()
  const bars = new Map<string, SigninBar>()
  const watchers = new Map<string, ReturnType<typeof setInterval>>()
  /** Accounts whose stale browser storage was already cleared once in this run. */
  const cleaned = new Set<string>()

  async function closeOne(accountId: string): Promise<void> {
    unlistens.get(accountId)?.()
    unlistens.delete(accountId)
    const watcher = watchers.get(accountId)
    if (watcher) clearInterval(watcher)
    watchers.delete(accountId)
    const current = windows.get(accountId)
    windows.delete(accountId)
    bars.get(accountId)?.dispose()
    bars.delete(accountId)
    if (current && !current.isDestroyed()) current.destroy()
    // The window pointed this partition at the account's proxy. Let the HTTP path re-apply its own.
    forgetProxyBinding(sessionPartition(accountId))
  }

  /** Why a window must not open: its task or account has a proxy group but no proxy could be chosen. */
  function directBlock(account: FullAccount, taskId?: string): { proxy?: ProxyEndpoint; blocked: string | null } {
    const resolved = proxyForAccountTask(db, account.id, taskId)
    if (resolved.directWithGroup) {
      const name = resolved.groupName ? ` (${resolved.groupName})` : ""
      return { blocked: `This account's proxy group${name} has no proxy available, so its browser would run direct and show your real IP. ${resolved.notes.join(" ")}`.trim() }
    }
    return { proxy: resolved.proxy, blocked: null }
  }

  async function prepare(
    account: FullAccount,
    title: string,
    show: boolean,
    options: { fresh?: boolean; taskId?: string; proxy?: ProxyEndpoint; bar?: { lang: "en" | "es" } } = {}
  ): Promise<{ win: BrowserWindow; ses: Session; page: WebContents }> {
    await closeOne(account.id)
    const ses = session.fromPartition(sessionPartition(account.id))
    if (options.fresh) {
      cleaned.add(account.id)
      await ses.clearStorageData().catch(() => undefined)
      await ses.clearCache().catch(() => undefined)
    }
    const proxy = options.proxy ?? proxyFor(db, account, options.taskId)
    await bindProxy(ses, proxy)
    forgetProxyBinding(sessionPartition(account.id))
    unlistens.set(account.id, watchProxyLogin(ses, proxy))
    const parent = getParent()
    const bar = options.bar
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      show,
      parent: parent ?? undefined,
      title,
      autoHideMenuBar: true,
      webPreferences: bar
        ? { ...barWindowPreferences(), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false }
        : { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false }
    })
    windows.set(account.id, win)
    let pageContents: WebContents = win.webContents
    if (bar) {
      const view = new WebContentsView({
        webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false }
      })
      pageContents = view.webContents
      // 0.2.44: a trusted bar above the page with the email and a masked password. Copy only, nothing is typed into the store.
      bars.set(account.id, attachSigninBar(win, view, { label: account.label, username: account.username, password: account.password, lang: bar.lang }))
      pageContents.on("page-title-updated", (_event, pageTitle) => {
        if (!win.isDestroyed()) win.setTitle(`${pageTitle} · ${account.label}`)
      })
    }
    win.on("closed", () => {
      if (windows.get(account.id) === win) windows.delete(account.id)
      bars.get(account.id)?.dispose()
      bars.delete(account.id)
    })
    pageContents.setWindowOpenHandler(({ url }) => {
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
    return { win, ses, page: pageContents }
  }

  return {
    async open(accountId, options) {
      const account = db.readAccount(accountId)
      const lang = db.getSettings().language === "es" ? "es" : "en"
      // A task's proxy group with no usable proxy would send this window direct. Ask first, never do it silently.
      const direct = directBlock(account)
      if (direct.blocked) {
        const pick = await dialog.showMessageBox({
          type: "warning",
          title: lang === "es" ? "Sin proxy disponible" : "No proxy available",
          message: lang === "es" ? "Esta ventana saldría sin proxy" : "This window would run without a proxy",
          detail: direct.blocked,
          buttons: lang === "es" ? ["Cancelar", "Abrir sin proxy"] : ["Cancel", "Open without proxy"],
          defaultId: 0,
          cancelId: 0
        })
        if (pick.response !== 1) throw new Error(lang === "es" ? "No se abrió la ventana: el grupo de proxy no tiene proxy disponible." : "The window was not opened: the proxy group has no proxy available.")
      }
      await openSignIn(account, options?.fresh === true, direct.blocked ? undefined : direct.proxy, lang)
    },
    async capture(accountId) {
      const account = db.readAccount(accountId)
      const header = await readCookies(account)
      if (!header) throw new Error("The browser has no cookies yet. Sign in, then save the session.")
      db.updateSession(account.id, applySolvedCookies(account.session, header))
      db.markSession(account.id, "saved", false)
    },
    async warm(accountId, options) {
      const run = () => warmAccount(accountId, options?.background === true, options?.taskId)
      if (!queue) return run()
      queue.setCap(db.getSettings().sessionWindowCap)
      return queue.run(run)
    },
    async close() {
      for (const id of [...windows.keys()]) await closeOne(id)
    }
  }

  async function openSignIn(account: FullAccount, fresh: boolean, proxy: ProxyEndpoint | undefined, lang: "en" | "es"): Promise<void> {
    // A profile with no saved session may hold leftovers from earlier blocked page loads. Start it clean once per run, or whenever asked.
    const clean = fresh || (!account.session && !cleaned.has(account.id))
    const { page } = await prepare(account, `Sign in · ${account.label}`, true, { fresh: clean, proxy, bar: { lang } })
    watchStoreError(account, page, proxy)
    await page.loadURL(storeHome(account.store)).catch(() => undefined)
  }

  /**
   * Read-only: if the store's own error banner shows in the sign-in window, say what it means and offer the
   * person's own browser. Nothing on the page is clicked, filled or changed.
   */
  function watchStoreError(account: FullAccount, page: WebContents, proxy: ProxyEndpoint | undefined): void {
    let asked = false
    const timer = setInterval(() => {
      if (asked) return
      const win = windows.get(account.id)
      if (!win || win.isDestroyed() || page.isDestroyed()) {
        clearInterval(timer)
        return
      }
      void (async () => {
        const text = String(await page.executeJavaScript("(document.body && document.body.innerText || '').slice(0, 4000)", false).catch(() => ""))
        if (asked || win.isDestroyed() || !pageShowsStoreError(account.store, text)) return
        asked = true
        const lang = db.getSettings().language === "es" ? "es" : "en"
        const words = signInRejectedMessage(lang)
        const pick = await dialog.showMessageBox(win, {
          type: "info",
          title: words.title,
          message: words.title,
          detail: words.detail,
          buttons: [words.browser, words.fresh, words.keep],
          defaultId: 0,
          cancelId: 2
        })
        if (pick.response === 0) await shell.openExternal(storeSignInUrl(account.store))
        if (pick.response === 1) {
          const again = db.readAccount(account.id)
          await closeOne(account.id)
          await openSignIn(again, true, proxy, lang)
        }
      })().catch(() => undefined)
    }, 2000)
    watchers.set(account.id, timer)
  }

  async function warmAccount(accountId: string, background = false, taskId?: string): Promise<WarmResult> {
      if (windows.has(accountId)) return { expired: false, detail: "The sign-in window is already open." }
      const account = db.readAccount(accountId)
      const direct = directBlock(account, taskId)
      if (direct.blocked) return { expired: false, detail: `${account.label}: not opened. ${direct.blocked}` }
      const { win } = await prepare(account, `Session warm-up · ${account.label}`, !background, { taskId, proxy: direct.proxy })
      try {
        const homeLoaded = await load(win, background ? KEEP_WARM_URL[account.store] ?? storeHome(account.store) : storeHome(account.store))
        if (homeLoaded && !win.isDestroyed()) {
          const html = String(await win.webContents.executeJavaScript("(document.documentElement && document.documentElement.outerHTML || '').slice(0, 60000)", false).catch(() => ""))
          if (pageShowsChallenge(html)) {
            return { expired: false, challenged: true, detail: `${account.label}: the store showed a check during keep-warm. Nothing was saved.` }
          }
        }
        const task = background ? undefined : db.listTasks().find((item) => item.accountId === account.id && item.store === account.store)
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

function proxyFor(db: Database, account: FullAccount, taskId?: string): ProxyEndpoint | undefined {
  return proxyForAccountTask(db, account.id, taskId).proxy
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
