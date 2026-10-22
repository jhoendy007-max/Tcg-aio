import { learnedDue, planTemplateStart, replacementAccount, stuckIds } from "./autopilot"
import type { Database } from "./database"
import type { HttpClient } from "./http"
import type { LineSocket } from "./imap"
import { imapCredential, readOrderMail } from "./mail-read"
import { fetchMailbox } from "./imap"
import { explainMailFailure, looksLikeStoreAlert, mailAlertDetail, storeForSender } from "../shared/mail"
import { orderStatusUrl, shipmentFromMail } from "./orders"
import { dayKey } from "./limits"
import { cookieHeader } from "./challenge"
import { healthReport, reportDue, reportZone } from "./watchdog"
import type { Notice } from "../shared/types"
import { isActiveStatus } from "../shared/types"

const ORDER_GAP_MS = 15 * 60 * 1000
const MAX_HEALS = 3

export interface HandsFreeRunner {
  start(id: string): void
  stop(id: string): void
  isRunning(id: string): boolean
  wait(id: string): Promise<void>
}

export class HandsFree {
  constructor(
    private readonly db: Database,
    private readonly runner: HandsFreeRunner,
    private readonly warm: (accountId: string) => Promise<{ expired: boolean }>,
    private readonly notify: (notice: Notice) => Promise<boolean>,
    private readonly http: HttpClient,
    private readonly connectMail: (input: { host: string; port: number; secure: boolean }) => Promise<LineSocket> = async () => {
      throw new Error("Mail is not connected.")
    }
  ) {}

  resumeInterrupted(): string[] {
    if (!this.db.getSettings().resumeOnLaunch) return []
    const started: string[] = []
    for (const id of this.db.takeInterrupted()) {
      try {
        this.runner.start(id)
        started.push(id)
      } catch {
        // A task that is not allowed to start stays paused.
      }
    }
    return started
  }

  async heal(now = Date.now()): Promise<void> {
    if (!this.db.getSettings().autopilot) return
    const settings = this.db.getSettings()
    const tasks = this.db.listTasks()
    for (const id of stuckIds(tasks, now, settings.stuckMinutes, this.db.heals(), MAX_HEALS)) {
      this.runner.stop(id)
      await this.runner.wait(id)
      this.db.bumpHeal(id)
      this.db.patchTask(id, { log: { ts: now, level: "warn", message: "Restarting a task that stopped logging." } })
      try {
        this.runner.start(id)
      } catch {
        // Confirmation or a missing account keeps the task stopped.
      }
    }
    const accounts = this.db.listAccounts()
    const busy = this.db.listTasks().filter((task) => isActiveStatus(task.status)).map((task) => task.accountId)
    for (const task of this.db.listTasks()) {
      if (task.status !== "paused" && !isActiveStatus(task.status)) continue
      const account = accounts.find((item) => item.id === task.accountId)
      if (!account || account.sessionState !== "expired") continue
      if (this.runner.isRunning(task.id)) {
        this.runner.stop(task.id)
        await this.runner.wait(task.id)
      }
      let expired = true
      try {
        expired = (await this.warm(account.id)).expired
      } catch {
        expired = true
      }
      if (expired) {
        const next = replacementAccount(accounts, account.id, task.store, busy)
        if (!next) continue
        this.db.reassignTask(task.id, next.id)
        this.db.patchTask(task.id, { log: { ts: now, level: "info", message: `Moved to account ${next.label} after the saved session expired.` } })
      }
      try {
        this.runner.start(task.id)
      } catch {
        // The replacement still needs a confirmed purchase or test mode.
      }
    }
    for (const task of this.db.listTasks()) {
      if (!task.proxyGroupId || !isActiveStatus(task.status)) continue
      if (task.accountId) continue
      const group = safeGroup(this.db, task.proxyGroupId)
      if (!group) continue
      const choice = this.db.assignProxy(task.id, group.id, group.proxies, now, false)
      if (choice.allBenched) {
        this.runner.stop(task.id)
        await this.runner.wait(task.id)
        this.db.patchTask(task.id, { status: "paused", detail: "Every proxy in the checkout pool is benched.", log: { ts: now, level: "warn", message: "Paused until a proxy is available again." } })
        continue
      }
      if (choice.rotated) {
        this.runner.stop(task.id)
        await this.runner.wait(task.id)
        this.db.patchTask(task.id, { log: { ts: now, level: "info", message: "Moved off a benched proxy." } })
        try {
          this.runner.start(task.id)
        } catch {
          // The task stays stopped when it cannot start.
        }
      }
    }
  }

  async learned(now = Date.now()): Promise<void> {
    const settings = this.db.getSettings()
    if (!settings.autopilot) return
    const due = learnedDue({
      hints: this.db.analytics().restockHints,
      templates: this.db.listTemplates(),
      tasks: this.db.listTasks(),
      fired: this.db.learnedKeys(),
      now,
      globalCap: settings.autopilotPriceCap,
      priceFor: (hint) => this.db.lastRestockPrice(hint.store, hint.sku)
    })
    for (const item of due) {
      this.db.markLearned(item.key)
      const plan = planTemplateStart({
        template: item.template,
        signal: { store: item.hint.store, sku: item.hint.sku, title: item.hint.sku, price: this.db.lastRestockPrice(item.hint.store, item.hint.sku) },
        accounts: this.db.listAccounts(),
        checkouts: this.db.listCheckouts(),
        settings,
        now
      })
      if (!plan.ok) continue
      const task = this.db.saveTask(plan.task)
      this.db.touchTemplate(plan.templateId, now)
      try {
        this.runner.start(task.id)
      } catch {
        continue
      }
      await this.notify({
        kind: "alert",
        storeName: item.hint.store,
        sku: item.hint.sku,
        profileName: "Autopilot",
        detail: `Learned restock hour ${item.hint.hourAst}:00. Started ${item.template.name}.`
      })
    }
  }

  async track(now = Date.now()): Promise<void> {
    const mailByStore = new Map<string, string>()
    for (const order of this.db.listOrders()) {
      if (order.status === "cancelled" || order.status === "delivered") continue
      if (order.checkedAt && now - order.checkedAt < ORDER_GAP_MS) continue
      const url = orderStatusUrl(order.store, order.orderId)
      let text = ""
      if (url) {
        try {
          const account = this.db.readAccount(order.accountId)
          const response = await this.http.request({
            method: "GET",
            url,
            headers: {
              accept: "text/html",
              cookie: cookieHeader(account.session)
            },
            timeoutMs: 15000
          })
          if (response.status >= 200 && response.status < 400) text = response.body
        } catch {
          text = ""
        }
      }
      let mail = mailByStore.get(order.store)
      if (mail === undefined) {
        mail = await readOrderMail(this.db, this.connectMail, order.store, now)
        mailByStore.set(order.store, mail)
      }
      const update = shipmentFromMail(`${text}\n${mail}`, order.orderId)
      if (!update) {
        this.db.touchOrder(order.id)
        continue
      }
      this.db.noteOrder(order.id, update.status, update.tracking, update.detail, update.carrier)
      await this.notify({
        kind: update.status === "cancelled" ? "failure" : "success",
        storeName: order.store,
        sku: order.sku,
        profileName: "Orders",
        detail: update.tracking ? `Tracking ${update.tracking}` : `Order ${order.orderId} is ${update.status}.`,
        orderId: order.orderId
      })
    }
  }

  async maybeReport(now = Date.now()): Promise<void> {
    const settings = this.db.getSettings()
    if (!reportDue(this.db.reportDay(), settings, now)) return
    const zone = reportZone(settings)
    const text = healthReport({
      accounts: this.db.listAccounts(),
      scores: this.db.proxyScores(),
      schedules: this.db.listSchedules(),
      checkouts: this.db.listCheckouts(),
      settings,
      now
    })
    this.db.setReportDay(dayKey(now, zone))
    await this.notify({ kind: "health", storeName: "Daily report", sku: "Health", profileName: "Zzz AIO", detail: text })
  }

  async watchMail(now = Date.now()): Promise<void> {
    const since = new Date(now - 2 * 24 * 60 * 60 * 1000)
    for (const login of this.db.mailboxLogins("alerts")) {
      try {
        const cred = await imapCredential(this.db, login)
        const socket = await this.connectMail({ host: login.host, port: login.port, secure: login.secure })
        const messages = await fetchMailbox(socket, { ...cred, mailbox: login.mailbox, since })
        this.db.noteMailbox(login.id, { ok: true, error: "" })
        for (const message of messages) {
          const store = storeForSender(message.from)
          if (!store || !looksLikeStoreAlert(message.subject, message.text)) continue
          if (!this.db.claimMailAlert(login.id, message.uid || message.subject)) continue
          await this.notify({
            kind: "alert",
            storeName: store,
            sku: "Mail",
            profileName: "Mail",
            detail: mailAlertDetail(message.subject)
          })
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : "Mail could not be read."
        this.db.noteMailbox(login.id, { ok: false, error: explainMailFailure(raw, login.provider, this.db.getSettings().language) })
      }
    }
  }
}

function safeGroup(db: Database, id: string) {
  try {
    return db.getProxyGroup(id)
  } catch {
    return null
  }
}
