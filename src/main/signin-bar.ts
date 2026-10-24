import { BrowserWindow, clipboard, ipcMain, WebContentsView, type WebContents } from "electron"
import { randomBytes } from "node:crypto"
import { BAR_CHANNELS, BAR_HEIGHT, barHtml, copyWithAutoClear, type BarField } from "../engine/signin-bar"
import { join } from "node:path"

interface BarState {
  username: string
  password: string
  cancel: (() => void) | null
}

const states = new Map<number, BarState>()
let registered = false

function register(): void {
  if (registered) return
  registered = true
  ipcMain.handle(BAR_CHANNELS.copy, (event, field: BarField) => {
    const state = states.get(event.sender.id)
    if (!state) return false
    const value = field === "user" ? state.username : field === "pass" ? state.password : ""
    if (!value) return false
    state.cancel?.()
    state.cancel = copyWithAutoClear(clipboard, value)
    return true
  })
  ipcMain.handle(BAR_CHANNELS.reveal, (event, show: boolean) => {
    const state = states.get(event.sender.id)
    return state && show === true ? state.password : ""
  })
}

export function barWindowPreferences(): { preload: string; partition: string } {
  return { preload: join(__dirname, "../preload/signin-bar.js"), partition: "zzz-signin-bar" }
}

export interface SigninBar {
  page: WebContentsView
  dispose(): void
}

/**
 * The window's own contents become the trusted bar. The store page is a separate view
 * below it, so nothing is injected into the store's DOM. The password is held in this
 * closure only while the window is open and is never logged.
 */
export function attachSigninBar(
  win: BrowserWindow,
  page: WebContentsView,
  creds: { label: string; username: string; password?: string; lang: "en" | "es" }
): SigninBar {
  register()
  const bar: WebContents = win.webContents
  states.set(bar.id, { username: creds.username, password: creds.password ?? "", cancel: null })
  const layout = () => {
    if (win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    page.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) })
  }
  win.contentView.addChildView(page)
  layout()
  win.on("resize", layout)
  win.on("maximize", layout)
  win.on("unmaximize", layout)
  win.on("enter-full-screen", layout)
  win.on("leave-full-screen", layout)
  const nonce = randomBytes(12).toString("base64")
  const html = barHtml({ label: creds.label, username: creds.username, hasPassword: Boolean(creds.password), lang: creds.lang, nonce })
  void bar.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  let done = false
  return {
    page,
    dispose() {
      if (done) return
      done = true
      const state = states.get(bar.id)
      if (state) {
        state.password = ""
        state.username = ""
      }
      states.delete(bar.id)
      try {
        if (!page.webContents.isDestroyed()) page.webContents.close()
      } catch {
        /* already closed */
      }
    }
  }
}
