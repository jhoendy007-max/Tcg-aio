import { useEffect, useRef, useState } from "react"
import { AccountsPage } from "./pages/Accounts"
import { ClientsPage } from "./pages/Clients"
import { ProfilesPage } from "./pages/Profiles"
import { ProxiesPage } from "./pages/Proxies"
import { PhonePage } from "./pages/Phone"
import { SettingsPage } from "./pages/Settings"
import { AlertsPage } from "./pages/Alerts"
import { TasksPage } from "./pages/Tasks"
import { KeeperPage } from "./pages/Keeper"
import { DropsPage } from "./pages/Drops"
import { AnalyticsPage } from "./pages/Analytics"
import { AutopilotPage } from "./pages/Autopilot"
import { VaultPage } from "./pages/Vault"
import { DashboardPage } from "./pages/Dashboard"
import { LogsPage } from "./pages/Logs"
import { ModulesPage } from "./pages/Modules"
import { ShipmentsPage } from "./pages/Shipments"
import { dropOpsText } from "../../shared/drop-ops"
import { Wizard } from "./pages/Wizard"
import { SuccessScreen, type WinCard } from "./components/Success"
import { moduleText } from "../../shared/module-settings"
import { updateStatusText } from "../../shared/update-status"
import { APP_VERSION } from "../../shared/version"
import { DEFAULT_SETTINGS, type Settings, type UpdateStatus } from "../../shared/types"
import { errorText, unwrap } from "./lib"
import { applyTheme } from "./theme"
import { playSuccessChime } from "./sound"

const PRIMARY = [
  { id: "home", label: "Dashboard" },
  { id: "tasks", label: "Tasks" },
  { id: "monitors", label: "Monitors" },
  { id: "profiles", label: "Profiles" },
  { id: "accounts", label: "Accounts" },
  { id: "proxies", label: "Proxies" },
  { id: "clients", label: "Clients" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" }
] as const

const MORE = [
  { id: "keeper", label: "Session Keeper" },
  { id: "vault", label: "Session Sync" },
  { id: "drops", label: "Drops" },
  { id: "stats", label: "Analytics" },
  { id: "ship", label: "Shipments" },
  { id: "alerts", label: "Alerts" },
  { id: "autopilot", label: "Autopilot" },
  { id: "phone", label: "Phone" },
  { id: "stores", label: "Stores" }
] as const

const PAGES = [...PRIMARY, ...MORE] as const

type PageId = (typeof PAGES)[number]["id"]

function pageFromHash(): PageId {
  const hash = window.location.hash.replace("#", "")
  return PAGES.some((page) => page.id === hash) ? (hash as PageId) : "home"
}

export function App() {
  const [page, setPage] = useState<PageId>(pageFromHash)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateError, setUpdateError] = useState("")
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [booting, setBooting] = useState(true)
  const [wizard, setWizard] = useState(false)
  const [win, setWin] = useState<WinCard | null>(null)
  const seen = useRef(new Map<string, string>())

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  useEffect(() => {
    let cancel = false
    void Promise.all([
      unwrap(window.aio.settings.get()),
      unwrap(window.aio.profiles.list()),
      unwrap(window.aio.accounts.list())
    ]).then(([payload, profiles, accounts]) => {
      if (cancel) return
      setSettings(payload.settings)
      applyTheme(payload.settings)
      document.title = payload.settings.appName || "TCGAIO"
      setWizard(!payload.settings.wizardDone && profiles.length === 0 && accounts.length === 0)
    }).catch(() => undefined).finally(() => {
      if (!cancel) setBooting(false)
    })
    return () => { cancel = true }
  }, [])

  useEffect(() => {
    const onSettings = (event: Event) => {
      const next = (event as CustomEvent<Settings>).detail
      if (!next) return
      setSettings(next)
      applyTheme(next)
      document.title = next.appName || "TCGAIO"
    }
    window.addEventListener("tcgaio-settings", onSettings)
    return () => window.removeEventListener("tcgaio-settings", onSettings)
  }, [])

  useEffect(() => {
    void unwrap(window.aio.updates.get()).then(setUpdate).catch(() => undefined)
    return window.aio.updates.onEvent(setUpdate)
  }, [])

  useEffect(() => {
    return window.aio.tasks.onEvent((event) => {
      if (event.type !== "upsert") {
        seen.current.delete(event.id)
        return
      }
      const before = seen.current.get(event.task.id)
      seen.current.set(event.task.id, event.task.status)
      if (!before || before === event.task.status) return
      if (event.task.status !== "success" && event.task.status !== "tested") return
      const task = event.task
      void unwrap(window.aio.analytics.get()).then((report) => {
        const match = report.recent.find((row) => row.sku === task.sku && (row.outcome === task.status || row.outcome === "success"))
        setWin({ task, price: match?.price ?? null, orderId: match?.orderId ?? "" })
      }).catch(() => setWin({ task, price: null, orderId: "" }))
      if (settings.successSound && task.status === "success") playSuccessChime()
    })
  }, [settings.successSound])

  async function setSound(on: boolean) {
    const next = { ...settings, successSound: on }
    setSettings(next)
    if (on) playSuccessChime()
    try {
      const saved = await unwrap(window.aio.settings.save(next))
      setSettings(saved.settings)
      window.dispatchEvent(new CustomEvent("tcgaio-settings", { detail: saved.settings }))
    } catch {
      setSettings(settings)
    }
  }

  function go(id: PageId) {
    window.location.hash = id
    setPage(id)
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          {settings.logoDataUrl ? <img className="brand-logo" src={settings.logoDataUrl} alt="" /> : <Mark />}
          <div>
            <strong>{settings.appName || "TCGAIO"}</strong>
            <span>Pokémon · One Piece</span>
          </div>
        </div>
        <nav aria-label="Sections">
          <div className="nav-label">Desk</div>
          {PRIMARY.map((item) => (
            <a key={item.id} href={`#${item.id}`} aria-current={page === item.id ? "page" : undefined}>
              <NavIcon name={item.id} />
              {item.label}
            </a>
          ))}
          <div className="nav-label">More</div>
          {MORE.map((item) => (
            <a key={item.id} href={`#${item.id}`} aria-current={page === item.id ? "page" : undefined}>
              <NavIcon name={item.id} />
              {item.id === "stores" ? moduleText(settings.language === "es" ? "es" : "en", "nav") : item.id === "ship" ? dropOpsText(settings.language === "es" ? "es" : "en", "navShip") : item.label}
            </a>
          ))}
        </nav>
        <footer>
          <span>v{APP_VERSION}</span>
          <span>Desktop, phone, browser</span>
        </footer>
      </aside>
      <main>
        {update && update.status !== "idle" && update.status !== "current" ? (
          <div className="card update-banner">
            <div>
              <strong>{update.status === "available" || update.status === "downloading" || update.status === "downloaded" ? `Update ${update.version ?? ""}` : "Updates"}</strong>
              <p>{updateStatusText(update)}</p>
              {update.notes && (update.status === "available" || update.status === "downloaded") ? <p>{update.notes.slice(0, 280)}</p> : null}
              {update.status === "downloading" ? <progress className="update-progress" value={update.percent ?? 0} max={100} /> : null}
              {updateError ? <div className="toast-stack" role="status"><div className="toast">{updateError}</div></div> : null}
            </div>
            <div className="actions">
              {update.status === "checking" || update.status === "error" ? <button type="button" onClick={() => void unwrap(window.aio.updates.check()).then(setUpdate).catch((err) => setUpdateError(errorText(err)))}>{update.status === "checking" ? "Checking…" : "Check for updates"}</button> : null}
              {update.status === "available" || update.status === "downloading" ? <button type="button" className="primary" disabled={update.status === "downloading"} onClick={() => void unwrap(window.aio.updates.download()).then(setUpdate).catch((err) => setUpdateError(errorText(err)))}>{update.status === "downloading" ? `Downloading ${Math.round(update.percent ?? 0)}%` : "Download"}</button> : null}
              {update.status === "downloaded" ? <button type="button" className="primary" onClick={() => void unwrap(window.aio.updates.install()).catch((err) => setUpdateError(errorText(err)))}>Restart and install</button> : null}
            </div>
          </div>
        ) : null}
        {booting ? <section className="page" aria-busy="true" aria-label="Loading"><div className="skeleton sk-title" /><div className="skeleton sk-card" /></section> : null}
        {!booting && wizard ? <Wizard onDone={(next) => { setSettings(next); applyTheme(next); document.title = next.appName || "TCGAIO"; setWizard(false); go("home") }} /> : null}
        {!booting && !wizard && page === "home" ? <DashboardPage onTasks={() => go("tasks")} /> : null}
        {!booting && !wizard && page === "tasks" ? <TasksPage /> : null}
        {!booting && !wizard && page === "monitors" ? <TasksPage lockedKind="monitor" /> : null}
        {!booting && !wizard && page === "logs" ? <LogsPage /> : null}
        {!booting && !wizard && page === "keeper" ? <KeeperPage /> : null}
        {!booting && !wizard && page === "vault" ? <VaultPage /> : null}
        {!booting && !wizard && page === "drops" ? <DropsPage /> : null}
        {!booting && !wizard && page === "stats" ? <AnalyticsPage /> : null}
        {!booting && !wizard && page === "ship" ? <ShipmentsPage /> : null}
        {!booting && !wizard && page === "alerts" ? <AlertsPage /> : null}
        {!booting && !wizard && page === "autopilot" ? <AutopilotPage /> : null}
        {!booting && !wizard && page === "clients" ? <ClientsPage /> : null}
        {!booting && !wizard && page === "profiles" ? <ProfilesPage /> : null}
        {!booting && !wizard && page === "proxies" ? <ProxiesPage /> : null}
        {!booting && !wizard && page === "accounts" ? <AccountsPage /> : null}
        {!booting && !wizard && page === "phone" ? <PhonePage /> : null}
        {!booting && !wizard && page === "settings" ? <SettingsPage /> : null}
        {!booting && !wizard && page === "stores" ? <ModulesPage /> : null}
      </main>
      {win ? <SuccessScreen win={win} sound={settings.successSound} onSound={(on) => void setSound(on)} onClose={() => setWin(null)} /> : null}
    </div>
  )
}

const NAV_PATH: Record<string, string> = {
  home: "M2.5 7.2 8 2.8l5.5 4.4V13.5H10V9.5H6v4H2.5z",
  tasks: "M3 3.5h10M3 8h10M3 12.5h6",
  monitors: "M2.5 3.5h11v7h-11zM6 13.2h4M8 10.5v2.7",
  profiles: "M8 8.2a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2zM3.4 13.2c.5-1.8 2.2-2.8 4.6-2.8s4.1 1 4.6 2.8",
  accounts: "M3 4.2h10v8H3zM3 7h10",
  proxies: "M3 8h10M8 3.2v9.6M4.2 5.2 8 8l3.8-2.8M4.2 10.8 8 8l3.8 2.8",
  clients: "M2.4 4.2h4.4v7.6H2.4zM9.2 4.2h4.4v7.6H9.2z",
  logs: "M4 3.2h8M4 6.4h8M4 9.6h8M4 12.8h5",
  settings: "M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1",
  keeper: "M8 2.8 13 5v4.2c0 2.6-2 4.2-5 5.2-3-1-5-2.6-5-5.2V5z",
  vault: "M4 7.2V4.8h8v2.4M3 7.2h10v6H3z",
  drops: "M8 2.5v7M5 6.5 8 9.5l3-3M3.5 12.5h9",
  stats: "M3 12.5V8M8 12.5V3.5M13 12.5V6",
  ship: "M2.5 10.5h11l-1.5 3h-8zM4 10.5 6 4.5h4l2 6",
  alerts: "M8 2.8a3.2 3.2 0 0 1 3.2 3.2v2.2l1 1.6H3.8l1-1.6V6A3.2 3.2 0 0 1 8 2.8zM6.6 12.6a1.4 1.4 0 0 0 2.8 0",
  autopilot: "M8 2.5 9.2 6.2 13 6.4 10.1 8.8 11.2 12.5 8 10.4 4.8 12.5 5.9 8.8 3 6.4 6.8 6.2z",
  phone: "M5.2 2.5h5.6v11H5.2zM7 11.8h2",
  stores: "M3 6.2 8 3l5 3.2V13H3zM6.5 13V8.5h3V13"
}

function NavIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={NAV_PATH[name] ?? NAV_PATH.home} />
    </svg>
  )
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="7" />
      <path d="M9 22.5 16 8l7 14.5H9z" />
    </svg>
  )
}
