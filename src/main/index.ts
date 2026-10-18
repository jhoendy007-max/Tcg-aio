import { app, BrowserWindow, safeStorage, session, shell } from "electron"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createAesCipher, createDpapiCipher, type Cipher } from "../engine/cipher"
import { Database } from "../engine/database"
import { AlertService, relayRestockUrl as relayUrl } from "../engine/alerts"
import { warmTaskMonitors } from "../engine/bench"
import { defaultHttp } from "../engine/http"
import { chromiumHttp } from "./chromium-http"
import { refreshStoreSession } from "../engine/store-browser"
import { postDiscord, postGroupDiscord } from "../engine/discord"
import { ChallengeGate } from "../engine/challenge-gate"
import { TaskService } from "../engine/task-runner"
import { channels } from "../shared/ipc"
import type { Notice, TaskEvent } from "../shared/types"
import { createPhoneHost } from "../phone/backend"
import { projectTask } from "../phone/protocol"
import { PhoneServer } from "../phone/server"
import { createRegistry, moduleAddressCaps } from "../stores/registry"
import { warmupDue } from "../engine/session-care"
import { moduleScope, resolveModule } from "../shared/module-settings"
import { storeName } from "../shared/stores"
import { createChallengeController } from "./challenge-window"
import { createSessionBrowser, type SessionBrowser } from "./session-window"
import { createUpdateController } from "./auto-update"
import { planDrops, tasksForSchedule } from "../engine/drops"
import { rehearsalDue, rehearseDrop } from "../engine/rehearsal"
import { dueRefreshes, dueWarmups, SessionWindowQueue } from "../shared/consistency"
import { HandsFree } from "../engine/hands-free"
import { openMailbox } from "../engine/imap"
import { readStoreCode } from "../engine/mail-read"
import { reportZone, shouldRelaunch } from "../engine/watchdog"
import { dayKey } from "../engine/limits"
import { cookieForVault, vaultScan } from "../engine/vault"
import { registerIpc } from "./ipc"
import type { Settings } from "../shared/types"

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let window: BrowserWindow | null = null
let runner: TaskService | null = null
let phone: PhoneServer | null = null
let alerts: AlertService | null = null
let sessions: SessionBrowser | null = null
const sessionWindows = new SessionWindowQueue()
const warming = new Set<string>()
let sessionTimer: ReturnType<typeof setInterval> | null = null
let dropTimer: ReturnType<typeof setInterval> | null = null
let handsTimer: ReturnType<typeof setInterval> | null = null
let hands: HandsFree | null = null
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
  db.setModuleAddressCaps(moduleAddressCaps(registry.values()))
  const gate = new ChallengeGate()
  const challenge = createChallengeController(gate, () => window)
  sessions = createSessionBrowser(db, () => window, sessionWindows)
  phone = new PhoneServer(createPhoneHost(db, () => runner, () => alerts, {
    open: () => challenge.open(),
    complete: () => challenge.complete(),
    dismiss: () => challenge.dismiss(),
    submit: (cookie) => challenge.submit(cookie),
    current: () => challenge.current()
  }, {
    open: (id) => sessions!.open(id)
  }, (url) => shell.openExternal(url), chromiumHttp), {
    onDevices: () => {
      if (phone) window?.webContents.send(channels.phoneEvent, phone.status())
    }
  })
  await phone.start()
  const desktop = phone
  db.onSessionSaved((accountId) => {
    const cookie = cookieForVault(db.readAccount(accountId).session)
    if (cookie) desktop.pushVaultSession(accountId, cookie)
  })
  const publish = async (notice: Notice) => {
    desktop.publishNotice({
      kind: notice.kind,
      storeName: notice.storeName,
      sku: notice.sku,
      profileName: notice.profileName,
      detail: notice.detail,
      orderId: notice.orderId,
      price: notice.price,
      url: notice.url,
      imageUrl: notice.imageUrl,
      inStock: notice.inStock,
      ts: Date.now()
    })
    const settings = db.getSettings()
    let delivered = false
    if (settings.discordWebhook) {
      await postDiscord(settings.discordWebhook, notice)
      delivered = true
    }
    await postGroupDiscord(settings, notice)
    return delivered
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
    chromiumHttp,
    gate,
    (input) => {
      sessionWindows.setCap(db.getSettings().sessionWindowCap)
      return sessionWindows.run(() => refreshStoreSession(input))
    },
    (store) => readStoreCode(db, openMailbox, store),
    async (accountId) => {
      await sessions?.warm(accountId)
    }
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
  registerIpc(db, runner, registry, () => window, desktop, alerts, challenge, sessions, updates, applyBoot)
  hands = new HandsFree(db, runner, (id) => sessions!.warm(id), publish, defaultHttp, (input) => openMailbox(input))
  if (db.getSettings().resumeOnLaunch) hands.resumeInterrupted()
  applyBoot(db.getSettings())
  installCrashRelaunch(db)
  const scanVault = () => {
    const now = Date.now()
    const day = dayKey(now, reportZone(db.getSettings()))
    const plan = vaultScan(db.vaultLinks(), db.listAccounts(), now, day)
    for (const id of plan.expireIds) db.markSession(id, "expired", false)
    for (const notice of plan.notices) {
      db.markVaultAlerted(notice.accountId, notice.deviceId, day, notice.loggedOut)
      void publish({
        kind: "session",
        storeName: notice.storeName,
        sku: notice.label,
        profileName: "Session Sync",
        detail: notice.detail
      })
    }
  }
  scanVault()
  handsTimer = setInterval(() => {
    void hands?.heal()
    void hands?.learned()
    void hands?.track()
    void hands?.watchMail()
    void hands?.maybeReport()
    scanVault()
  }, 60_000)
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
  if (handsTimer) clearInterval(handsTimer)
  clearCrashFlag()
  void sessions?.close()
  alerts?.stop()
  runner?.haltAll()
  void phone?.stop()
})

function applyBoot(settings: Settings): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.launchOnBoot === true,
      args: settings.resumeOnLaunch ? ["--resume"] : []
    })
  } catch {
    // Login items are a Windows setting. Other platforms keep the preference stored.
  }
}

function crashFile(): string {
  return join(app.getPath("userData"), "crash-relaunch.json")
}

function clearCrashFlag(): void {
  try {
    if (existsSync(crashFile())) unlinkSync(crashFile())
  } catch {
    // The next launch still refuses to relaunch more than once a minute.
  }
}

function installCrashRelaunch(db: { getSettings(): Settings }): void {
  process.on("uncaughtException", (err) => {
    console.error(err)
    if (!db.getSettings().relaunchOnCrash) {
      app.exit(1)
      return
    }
    let last = 0
    try {
      last = Number(JSON.parse(readFileSync(crashFile(), "utf8")).at) || 0
    } catch {
      last = 0
    }
    const now = Date.now()
    if (!shouldRelaunch(last, now)) return
    try {
      writeFileSync(crashFile(), JSON.stringify({ at: now }))
    } catch {
      return
    }
    app.relaunch({ args: ["--resume"] })
    app.exit(1)
  })
}

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
        const matched = db.listTasks().filter((task) => plan.taskIds.includes(task.id))
        await warmTaskMonitors(chromiumHttp, matched, db.listProxyGroups()).catch(() => undefined)
        for (const accountId of plan.accountIds) {
          if (accountId) await warmTracked(db, accountId)
        }
        await publish({ kind: "drop", storeName: "Session Keeper", sku: plan.name, profileName: "Drop", detail: "The account browser loaded the store before the drop. Warm-up does not add to cart." })
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
    await preDropCare(db)
    await runRehearsals(db, publish)
  } finally {
    dropBusy = false
  }
}

async function preDropCare(db: Database): Promise<void> {
  if (!sessions) return
  const now = Date.now()
  const settings = db.getSettings()
  const accounts = db.listAccounts()
  const tasks = db.listTasks()
  let started = 0
  for (const schedule of db.listSchedules()) {
    if (!schedule.enabled || schedule.phase === "stopped" || schedule.phase === "started") continue
    if (now >= schedule.startAt) continue
    const ids = new Set(tasksForSchedule(schedule, tasks).map((task) => task.accountId).filter(Boolean))
    const matched = accounts.filter((account) => ids.has(account.id))
    const refreshes = dueRefreshes(matched, schedule.startAt, now, settings.sessionWarmupMin)
    const warms = dueWarmups(matched, schedule.startAt, now, settings.sessionWarmup)
    const inStagger = now >= schedule.startAt - 180_000
    const limit = inStagger ? settings.sessionWindowCap : 1
    for (const step of [...refreshes, ...warms]) {
      if (started >= limit || warming.has(step.accountId)) continue
      started += 1
      void warmTracked(db, step.accountId)
    }
  }
}

async function runRehearsals(db: Database, publish: (notice: Notice) => Promise<boolean>): Promise<void> {
  const now = Date.now()
  const settings = db.getSettings()
  const tasks = db.listTasks()
  const accounts = db.listAccounts()
  const profiles = db.listProfiles()
  const scores = db.proxyScores()
  const lang = settings.language === "es" ? "es" : "en"
  for (const schedule of db.listSchedules()) {
    if (!rehearsalDue(schedule, now)) continue
    const report = rehearseDrop({
      tasks: tasksForSchedule(schedule, tasks),
      accounts,
      profiles,
      scores,
      now,
      freshMin: settings.sessionWarmupMin,
      lang
    })
    db.markRehearsal(schedule.id, now)
    await publish({
      kind: "drop",
      storeName: "Rehearsal",
      sku: schedule.name,
      profileName: "Drop",
      detail: report.detail
    })
  }
}

async function warmTracked(db: Database, accountId: string): Promise<void> {
  if (!sessions || warming.has(accountId)) return
  warming.add(accountId)
  try {
    await sessions.warm(accountId)
  } catch {
    const current = db.listAccounts().find((account) => account.id === accountId)
    if (current) db.markSession(accountId, current.sessionState, true)
  } finally {
    warming.delete(accountId)
  }
}

async function warmNext(db: Database, publish: (notice: Notice) => Promise<boolean>): Promise<void> {
  const settings = db.getSettings()
  if (!settings.sessionWarmup || !sessions) return
  const due = db.listAccounts().find((account) => {
    if (!account.hasSession || account.sessionState === "expired") return false
    const minutes = resolveModule(account.store, moduleScope(settings)).sessionRefreshMin.value
    return warmupDue(account.lastWarmAt, minutes, Date.now())
  })
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
