import { app, BrowserWindow, safeStorage, session } from "electron"
import { join } from "node:path"
import { createAesCipher, createDpapiCipher, type Cipher } from "../engine/cipher"
import { Database } from "../engine/database"
import { AlertService, relayRestockUrl as relayUrl } from "../engine/alerts"
import { defaultHttp } from "../engine/http"
import { postDiscord } from "../engine/discord"
import { ChallengeGate } from "../engine/challenge-gate"
import { TaskService } from "../engine/task-runner"
import { channels } from "../shared/ipc"
import type { Notice, TaskEvent } from "../shared/types"
import { createPhoneHost } from "../phone/backend"
import { projectTask } from "../phone/protocol"
import { PhoneServer } from "../phone/server"
import { createRegistry } from "../stores/registry"
import { warmupDue } from "../engine/session-care"
import { storeName } from "../shared/stores"
import { createChallengeController } from "./challenge-window"
import { createSessionBrowser, type SessionBrowser } from "./session-window"
import { createUpdateController } from "./auto-update"
import { planDrops } from "../engine/drops"
import { registerIpc } from "./ipc"

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let window: BrowserWindow | null = null
let runner: TaskService | null = null
let phone: PhoneServer | null = null
let alerts: AlertService | null = null
let sessions: SessionBrowser | null = null
let sessionTimer: ReturnType<typeof setInterval> | null = null
let dropTimer: ReturnType<typeof setInterval> | null = null
let dropBusy = false

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
  const gate = new ChallengeGate()
  const challenge = createChallengeController(gate, () => window)
  sessions = createSessionBrowser(db, () => window)
  phone = new PhoneServer(createPhoneHost(db, () => runner, () => alerts, {
    open: () => challenge.open(),
    complete: () => challenge.complete(),
    dismiss: () => challenge.dismiss(),
    submit: (cookie) => challenge.submit(cookie),
    current: () => challenge.current()
  }, {
    open: (id) => sessions!.open(id)
  }), {
    onDevices: () => {
      if (phone) window?.webContents.send(channels.phoneEvent, phone.status())
    }
  })
  await phone.start()
  const desktop = phone
  const publish = async (notice: Notice) => {
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
  runner = new TaskService(
    db,
    registry,
    (event: TaskEvent) => {
      window?.webContents.send(channels.taskEvent, event)
      if (event.type === "delete") desktop.publishDelete(event.id)
      else desktop.publishTask(projectTask(event.task, db.listProfiles(), db.listAccounts(), db.listProxyGroups()))
    },
    publish,
    defaultHttp,
    gate
  )
  alerts = new AlertService(db, () => runner, publish, defaultHttp)
  desktop.setRestock((authorization, alternate, body) => alerts!.ingestHttp(authorization, alternate, body))
  alerts.onChange(() => {
    const status = desktop.status()
    alerts?.setUrls({
      localUrl: `http://${status.host}:${status.port}/v1/restock`,
      relayUrl: relayUrl(status.relay, db.pcId())
    })
    window?.webContents.send(channels.alertsEvent, alerts?.view({
      localUrl: `http://${status.host}:${status.port}/v1/restock`,
      relayUrl: relayUrl(status.relay, db.pcId())
    }))
    if (alerts) desktop.publishAlerts(alerts.phoneAlerts())
  })
  alerts.start()
  gate.onChange((current) => {
    window?.webContents.send(channels.challengeEvent, current)
    desktop.publishChallenge(current ? challenge.current() : null)
    if (current) {
      void challenge.open().catch((err) => {
        console.error(err instanceof Error ? err.message : err)
      })
    }
    else void challenge.close()
  })
  const updates = createUpdateController(db, (status) => {
    window?.webContents.send(channels.updatesEvent, status)
  })
  registerIpc(db, runner, registry, () => window, desktop, alerts, challenge, sessions, updates)
  sessionTimer = setInterval(() => {
    void warmNext(db, publish)
  }, 60_000)
  dropTimer = setInterval(() => {
    void tickDrops(db, publish, desktop)
  }, 15_000)
  if (db.hasUpdateToken()) void updates.check()
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
  if (sessionTimer) clearInterval(sessionTimer)
  if (dropTimer) clearInterval(dropTimer)
  void sessions?.close()
  alerts?.stop()
  runner?.stopAll()
  void phone?.stop()
})

async function tickDrops(db: Database, publish: (notice: Notice) => Promise<boolean>, desktop: { publishSnapshot(): void }): Promise<void> {
  if (dropBusy || !runner || !sessions) return
  dropBusy = true
  try {
    const plans = planDrops(db.listSchedules(), db.listTasks(), Date.now())
    for (const plan of plans) {
      if (plan.action === "missed") {
        db.setSchedulePhase(plan.id, "stopped")
        await publish({ kind: "drop", storeName: "Drop", sku: plan.name, profileName: "Scheduler", detail: "The start time passed before this drop could run." })
        continue
      }
      if (plan.action === "warm") {
        db.setSchedulePhase(plan.id, "warming")
        for (const accountId of plan.accountIds) {
          try {
            await sessions.warm(accountId)
          } catch {
            // A page that fails to load does not erase the saved session.
          }
        }
        await publish({ kind: "drop", storeName: "Session Keeper", sku: plan.name, profileName: "Drop", detail: "Session Keeper opened the store pages before the drop." })
      }
      if (plan.action === "start") {
        db.setSchedulePhase(plan.id, "started")
        for (const id of plan.taskIds) {
          try {
            runner.start(id)
          } catch {
            // The task stays idle when it is not allowed to start.
          }
        }
        await publish({
          kind: "drop",
          storeName: "Drop",
          sku: plan.name,
          profileName: "Scheduler",
          detail: plan.taskIds.length ? `Started ${plan.taskIds.length} task${plan.taskIds.length === 1 ? "" : "s"}.` : "No tasks matched this drop."
        })
      }
      if (plan.action === "stop") {
        for (const id of plan.taskIds) runner.stop(id)
        db.setSchedulePhase(plan.id, "stopped")
        await publish({ kind: "drop", storeName: "Drop", sku: plan.name, profileName: "Scheduler", detail: "Stopped the scheduled tasks." })
      }
    }
    if (plans.length) desktop.publishSnapshot()
  } finally {
    dropBusy = false
  }
}

async function warmNext(db: Database, publish: (notice: Notice) => Promise<boolean>): Promise<void> {
  const settings = db.getSettings()
  if (!settings.sessionWarmup || !sessions) return
  const due = db.listAccounts().find((account) => account.hasSession && account.sessionState !== "expired" && warmupDue(account.lastWarmAt, settings.sessionWarmupMin, Date.now()))
  if (!due) return
  try {
    const result = await sessions.warm(due.id)
    if (!result.expired) return
    await publish({
      kind: "session",
      storeName: storeName(due.store),
      sku: due.label,
      profileName: "Session",
      detail: result.detail
    })
  } catch {
    db.markSession(due.id, due.sessionState, true)
  }
}
app.on("window-all-closed", () => app.quit())
