import { app, BrowserWindow, safeStorage, session } from "electron"
import { join } from "node:path"
import { createAesCipher, createDpapiCipher, type Cipher } from "../engine/cipher"
import { Database } from "../engine/database"
import { postDiscord } from "../engine/discord"
import { TaskService } from "../engine/task-runner"
import { channels } from "../shared/ipc"
import type { TaskEvent } from "../shared/types"
import { createPhoneHost } from "../phone/backend"
import { projectTask } from "../phone/protocol"
import { PhoneServer } from "../phone/server"
import { createRegistry } from "../stores/registry"
import { registerIpc } from "./ipc"

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let window: BrowserWindow | null = null
let runner: TaskService | null = null
let phone: PhoneServer | null = null

function createCipher(): Cipher {
  if (safeStorage.isEncryptionAvailable()) return createDpapiCipher(safeStorage)
  return createAesCipher(app.getPath("userData"))
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#101114",
    title: "TCGAIO",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.once("ready-to-show", () => window?.show())
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, "../renderer/index.html"))
  window.on("closed", () => {
    window = null
  })
}

if (gotLock) void app.whenReady().then(async () => {
  if (!process.env.ELECTRON_RENDERER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": ["default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:"]
        }
      })
    })
  }
  const db = new Database(join(app.getPath("userData"), "tcgaio.json"), createCipher())
  db.load()
  const registry = createRegistry()
  phone = new PhoneServer(createPhoneHost(db, () => runner), {
    onDevices: () => {
      if (phone) window?.webContents.send(channels.phoneEvent, phone.status())
    }
  })
  await phone.start()
  const desktop = phone
  runner = new TaskService(
    db,
    registry,
    (event: TaskEvent) => {
      window?.webContents.send(channels.taskEvent, event)
      if (event.type === "delete") desktop.publishDelete(event.id)
      else desktop.publishTask(projectTask(event.task, db.listProfiles(), db.listAccounts(), db.listProxyGroups()))
    },
    async (notice) => {
      desktop.publishNotice({
        kind: notice.kind,
        storeName: notice.storeName,
        sku: notice.sku,
        profileName: notice.profileName,
        detail: notice.detail,
        orderId: notice.orderId,
        ts: Date.now()
      })
      const webhook = db.getSettings().discordWebhook
      if (!webhook) return false
      await postDiscord(webhook, notice)
      return true
    }
  )
  registerIpc(db, runner, registry, () => window, desktop)
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("second-instance", () => {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.focus()
})

app.on("before-quit", () => {
  runner?.stopAll()
  void phone?.stop()
})
app.on("window-all-closed", () => app.quit())
