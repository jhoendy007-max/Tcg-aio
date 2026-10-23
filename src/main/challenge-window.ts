import { app, BrowserWindow, session, type Session } from "electron"
import type { ChallengeGate } from "../engine/challenge-gate"
import { chromiumProxyRules } from "../engine/chromium-session"
import { challengeHost, splitCookieHeader } from "../engine/challenge"
import { challengeSolved, cookieMap } from "../shared/challenge-solved"
import type { PublicChallenge } from "../shared/types"

export interface ChallengeController {
  open(): Promise<void>
  complete(): Promise<void>
  dismiss(): void
  submit(cookie: string): void
  close(): Promise<void>
  /** Bring the solve window to the front (opens it if it was closed). Used by the desktop notification. */
  focus(): Promise<void>
  current(): (PublicChallenge & { cookie: string }) | null
}

/**
 * Desktop browser for a human solve. The partition uses the task proxy and
 * the task cookies. Closing the window does not submit. A person clicks Done.
 */
export function createChallengeController(gate: ChallengeGate, getParent: () => BrowserWindow | null): ChallengeController {
  let window: BrowserWindow | null = null
  let openId: string | null = null
  let unlisten: (() => void) | null = null
  let watchTimer: ReturnType<typeof setInterval> | null = null

  function stopWatch(): void {
    if (watchTimer) clearInterval(watchTimer)
    watchTimer = null
  }

  /**
   * 0.2.40: watch (read-only) for the person finishing the check, then hand the cookies back
   * so the task resumes without anyone clicking Done. Nothing on the page is touched.
   */
  function watchSolved(win: BrowserWindow, ses: Session, view: PublicChallenge, seedHeader: string): void {
    stopWatch()
    const host = challengeHost(view.store)
    const seed = cookieMap(seedHeader)
    let busy = false
    watchTimer = setInterval(() => {
      if (busy) return
      if (win.isDestroyed() || gate.current()?.id !== view.id) {
        stopWatch()
        return
      }
      busy = true
      void (async () => {
        const html = String(await win.webContents.executeJavaScript("(document.documentElement && document.documentElement.outerHTML || '').slice(0, 60000)", false))
        const list = await ses.cookies.get({ url: `https://${host}/` })
        const cookies = Object.fromEntries(list.map((cookie) => [cookie.name, cookie.value]))
        const verdict = challengeSolved(view.store, host, seed, { url: win.webContents.getURL(), html, cookies })
        if (verdict.solved && gate.current()?.id === view.id) {
          stopWatch()
          await complete()
        }
      })().catch(() => undefined).finally(() => {
        busy = false
      })
    }, 1500)
  }

  async function close(): Promise<void> {
    stopWatch()
    unlisten?.()
    unlisten = null
    const id = openId
    const current = window
    window = null
    openId = null
    if (current && !current.isDestroyed()) current.destroy()
    if (!id) return
    try {
      await session.fromPartition(partition(id)).clearStorageData()
    } catch {
      // The partition is already gone.
    }
  }

  async function open(): Promise<void> {
    const view = gate.current()
    const request = gate.currentRequest()
    if (!view || !request) throw new Error("No challenge is waiting.")
    const id = view.id
    await close()
    if (gate.current()?.id !== id) return
    const ses = session.fromPartition(partition(view.id))
    await ses.clearStorageData()
    await bindProxy(ses, request.proxy)
    unlisten = watchProxyLogin(request.proxy)
    const origin = `https://${challengeHost(view.store)}/`
    for (const cookie of splitCookieHeader(request.cookie)) {
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
        // A rejected seed cookie does not block the person from solving the page.
      }
    }
    const parent = getParent()
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      parent: parent ?? undefined,
      title: `Solve ${view.storeName}`,
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false
      }
    })
    window = win
    openId = view.id
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
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false
          }
        }
      }
    })
    win.on("closed", () => {
      if (window === win) window = null
    })
    if (gate.current()?.id !== id) {
      win.destroy()
      return
    }
    watchSolved(win, ses, view, request.cookie)
    await win.loadURL(view.url).catch(() => undefined)
  }

  async function complete(): Promise<void> {
    const view = gate.current()
    if (!view) throw new Error("No challenge is waiting.")
    const host = challengeHost(view.store)
    const cookies = await session.fromPartition(partition(view.id)).cookies.get({ url: `https://${host}/` })
    const header = cookies
      .filter((cookie) => cookie.name && cookie.value)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ")
    if (!header) throw new Error("The challenge browser has no cookies yet. Solve the page, then try again.")
    gate.submit(view.id, header)
  }

  return {
    open,
    complete,
    dismiss() {
      const view = gate.current()
      if (!view) return
      gate.dismiss(view.id)
    },
    submit(cookie: string) {
      const view = gate.current()
      if (!view) throw new Error("No challenge is waiting.")
      gate.submit(view.id, cookie)
    },
    close,
    async focus() {
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
        return
      }
      if (gate.current()) await open()
    },
    current: () => gate.phoneView()
  }
}

function partition(id: string): string {
  return `challenge-${id}`
}

async function bindProxy(ses: Session, proxy: { host: string; port: number; username?: string; password?: string } | undefined): Promise<void> {
  if (!proxy) {
    await ses.setProxy({ mode: "direct" })
    return
  }
  await ses.setProxy({ proxyRules: chromiumProxyRules(proxy) })
}

function watchProxyLogin(proxy: { username?: string; password?: string } | undefined): () => void {
  if (!proxy?.username) return () => undefined
  const username = proxy.username
  const password = proxy.password ?? ""
  const listener = (event: Electron.Event, _webContents: Electron.WebContents, _details: Electron.AuthenticationResponseDetails, authInfo: Electron.AuthInfo, callback: (username?: string, password?: string) => void) => {
    if (!authInfo.isProxy) return
    event.preventDefault()
    callback(username, password)
  }
  app.on("login", listener)
  return () => {
    app.removeListener("login", listener)
  }
}
