import { useEffect, useState } from "react"
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
import { APP_VERSION } from "../../shared/version"
import type { UpdateStatus } from "../../shared/types"
import { errorText, unwrap } from "./lib"

const PAGES = [
  { id: "tasks", label: "Tasks" },
  { id: "keeper", label: "Session Keeper" },
  { id: "drops", label: "Drops" },
  { id: "stats", label: "Analytics" },
  { id: "alerts", label: "Alerts" },
  { id: "autopilot", label: "Autopilot" },
  { id: "profiles", label: "Profiles" },
  { id: "proxies", label: "Proxies" },
  { id: "accounts", label: "Accounts" },
  { id: "phone", label: "Phone" },
  { id: "settings", label: "Settings" }
] as const

type PageId = (typeof PAGES)[number]["id"]

function pageFromHash(): PageId {
  const hash = window.location.hash.replace("#", "")
  return PAGES.some((page) => page.id === hash) ? (hash as PageId) : "tasks"
}

export function App() {
  const [page, setPage] = useState<PageId>(pageFromHash)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateError, setUpdateError] = useState("")

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  useEffect(() => {
    void unwrap(window.aio.updates.get()).then(setUpdate).catch(() => undefined)
    return window.aio.updates.onEvent(setUpdate)
  }, [])

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <div>
            <strong>TCGAIO</strong>
            <span>Pokémon · One Piece</span>
          </div>
        </div>
        <nav>
          {PAGES.map((item) => (
            <a key={item.id} href={`#${item.id}`} aria-current={page === item.id ? "page" : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
        <footer>
          <span>v{APP_VERSION}</span>
          <span>Desktop + phone</span>
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
        {page === "tasks" ? <TasksPage /> : null}
        {page === "keeper" ? <KeeperPage /> : null}
        {page === "drops" ? <DropsPage /> : null}
        {page === "stats" ? <AnalyticsPage /> : null}
        {page === "alerts" ? <AlertsPage /> : null}
        {page === "autopilot" ? <AutopilotPage /> : null}
        {page === "profiles" ? <ProfilesPage /> : null}
        {page === "proxies" ? <ProxiesPage /> : null}
        {page === "accounts" ? <AccountsPage /> : null}
        {page === "phone" ? <PhonePage /> : null}
        {page === "settings" ? <SettingsPage /> : null}
      </main>
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
