import { useEffect, useRef, useState } from "react"
import { AccountsPage } from "./pages/Accounts"
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
import { ModulesPage } from "./pages/Modules"
import { ShipmentsPage } from "./pages/Shipments"
import { dropOpsText } from "../../shared/drop-ops"
import { Wizard } from "./pages/Wizard"
import { SuccessScreen, type WinCard } from "./components/Success"
import { moduleText } from "../../shared/module-settings"
import { APP_VERSION } from "../../shared/version"
import { DEFAULT_SETTINGS, type Settings, type UpdateStatus } from "../../shared/types"
import { errorText, unwrap } from "./lib"
import { applyTheme } from "./theme"
import { playSuccessChime } from "./sound"

const PAGES = [
  { id: "home", label: "Home" },
  { id: "tasks", label: "Tasks" },
  { id: "keeper", label: "Session Keeper" },
  { id: "vault", label: "Session Sync" },
  { id: "drops", label: "Drops" },
  { id: "stats", label: "Analytics" },
  { id: "ship", label: "Shipments" },
  { id: "alerts", label: "Alerts" },
  { id: "autopilot", label: "Autopilot" },
  { id: "profiles", label: "Profiles" },
  { id: "proxies", label: "Proxies" },
  { id: "accounts", label: "Accounts" },
  { id: "phone", label: "Phone" },
  { id: "settings", label: "Settings" },
  { id: "stores", label: "Stores" }
] as const

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
          {PAGES.map((item) => (
            <a key={item.id} href={`#${item.id}`} aria-current={page === item.id ? "page" : undefined}>
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
        {update && (update.status === "available" || update.status === "downloaded" || update.status === "downloading") ? (
          <div className="card update-banner">
            <div>
              <strong>Update {update.version}</strong>
              <p>{update.notes ? update.notes.slice(0, 280) : "A newer TCGAIO release is on GitHub."}</p>
              {updateError ? <p>{updateError}</p> : null}
            </div>
            <div className="actions">
              {update.status !== "downloaded" ? <button type="button" className="primary" onClick={() => void unwrap(window.aio.updates.download()).then(setUpdate).catch((err) => setUpdateError(errorText(err)))}>{update.status === "downloading" ? "Downloading…" : "Download"}</button> : null}
              {update.status === "downloaded" ? <button type="button" className="primary" onClick={() => void unwrap(window.aio.updates.install()).catch((err) => setUpdateError(errorText(err)))}>Restart and install</button> : null}
            </div>
          </div>
        ) : null}
        {booting ? <section className="page" aria-busy="true" aria-label="Loading"><div className="skeleton sk-title" /><div className="skeleton sk-card" /></section> : null}
        {!booting && wizard ? <Wizard onDone={(next) => { setSettings(next); applyTheme(next); document.title = next.appName || "TCGAIO"; setWizard(false); go("home") }} /> : null}
        {!booting && !wizard && page === "home" ? <DashboardPage onTasks={() => go("tasks")} /> : null}
        {!booting && !wizard && page === "tasks" ? <TasksPage /> : null}
        {!booting && !wizard && page === "keeper" ? <KeeperPage /> : null}
        {!booting && !wizard && page === "vault" ? <VaultPage /> : null}
        {!booting && !wizard && page === "drops" ? <DropsPage /> : null}
        {!booting && !wizard && page === "stats" ? <AnalyticsPage /> : null}
        {!booting && !wizard && page === "ship" ? <ShipmentsPage /> : null}
        {!booting && !wizard && page === "alerts" ? <AlertsPage /> : null}
        {!booting && !wizard && page === "autopilot" ? <AutopilotPage /> : null}
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

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="7" />
      <path d="M9 22.5 16 8l7 14.5H9z" />
    </svg>
  )
}
