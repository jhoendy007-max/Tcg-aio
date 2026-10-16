import { app, BrowserWindow, session, type Session } from "electron"
import type { ChallengeGate } from "../engine/challenge-gate"
import { challengeHost, splitCookieHeader } from "../engine/challenge"
import type { PublicChallenge } from "../shared/types"

export interface ChallengeController {
  open(): Promise<void>
  complete(): Promise<void>
  dismiss(): void
  submit(cookie: string): void
  close(): Promise<void>
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

  async function close(): Promise<void> {
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
    await win.loadURL(view.url)
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
  await ses.setProxy({ proxyRules: `http://${proxy.host}:${proxy.port};https://${proxy.host}:${proxy.port}` })
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
