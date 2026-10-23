import { useEffect, useRef, useState } from "react"
import { BrandLockup, ZzzLogo } from "./Logo"
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
import { LogsPage } from "./pages/Logs"
import { ModulesPage } from "./pages/Modules"
import { ShipmentsPage } from "./pages/Shipments"
import { StoreDefaults } from "./pages/StoreDefaults"
import { AccountGate, WaitingAccount } from "./pages/AccountGate"
import { AcoPage } from "./pages/Aco"
import { Wizard } from "./pages/Wizard"
import { deskText } from "../../shared/desk-ui"
import { grantFeatures } from "../../shared/entitlements"
import { parseRoute, routeHash, type SectionId } from "../../shared/nav"
import { SuccessScreen, type WinCard } from "./components/Success"
import { UpdatePrompt } from "./components/UpdatePrompt"
import { updateStatusText } from "../../shared/update-status"
import { APP_VERSION } from "../../shared/version"
import { DEFAULT_SETTINGS, type AccountView, type Settings, type UpdateStatus } from "../../shared/types"
import { errorText, unwrap } from "./lib"
import { applyTheme } from "./theme"
import { playSuccessChime } from "./sound"

const NAV: Array<{ id: SectionId; icon: string; label: "navHome" | "navTasks" | "navProfiles" | "navProxies" | "navAccounts" | "navAco" | "navSettings" }> = [
  { id: "home", icon: "home", label: "navHome" },
  { id: "tasks", icon: "tasks", label: "navTasks" },
  { id: "profiles", icon: "profiles", label: "navProfiles" },
  { id: "proxies", icon: "proxies", label: "navProxies" },
  { id: "accounts", icon: "accounts", label: "navAccounts" },
  { id: "aco", icon: "clients", label: "navAco" },
  { id: "settings", icon: "settings", label: "navSettings" }
]

function readRail(): boolean {
  try { return localStorage.getItem("tcgaio-rail") === "icons" } catch { return false }
}

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  const [rail, setRail] = useState(readRail)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateError, setUpdateError] = useState("")
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [booting, setBooting] = useState(true)
  const [account, setAccount] = useState<AccountView | null>(null)
  const [wizard, setWizard] = useState(false)
  const [win, setWin] = useState<WinCard | null>(null)
  const seen = useRef(new Map<string, string>())

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  useEffect(() => {
    let cancel = false
    void Promise.all([
      unwrap(window.aio.settings.get()),
      unwrap(window.aio.profiles.list()),
      unwrap(window.aio.accounts.list())
    ]).then(async ([payload, profiles, accounts]) => {
      if (cancel) return
      setSettings(payload.settings)
      applyTheme(payload.settings)
      document.title = brandName(payload.settings.appName)
      setWizard(!payload.settings.wizardDone && profiles.length === 0 && accounts.length === 0)
      try {
        const nextAccount = await unwrap(window.aio.account.status())
        if (!cancel) setAccount(nextAccount)
      } catch {
        if (!cancel) setAccount(null)
      }
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
      document.title = brandName(next.appName)
    }
    window.addEventListener("tcgaio-settings", onSettings)
    const onSignOut = () => setAccount(null)
    window.addEventListener("tcgaio-signout", onSignOut)
    return () => {
      window.removeEventListener("tcgaio-settings", onSettings)
      window.removeEventListener("tcgaio-signout", onSignOut)
    }
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

  function go(section: SectionId, tab = "") {
    window.location.hash = routeHash(section, tab)
    setRoute({ section, tab: parseRoute(routeHash(section, tab)).tab })
  }

  const lang = settings.language === "es" ? "es" : "en"
  const signedIn = Boolean(account?.signedIn && !account.pending)
  const features = grantFeatures({ role: account?.role, email: account?.email, features: account?.features })
  const pending = Boolean(account?.pending)
  const page = route.section
  const tab = route.tab

  return (
    <div className={rail ? "shell rail" : "shell expanded"}>
      <aside className="sidebar">
        <div className="brand" title={brandName(settings.appName)}>
          {settings.logoDataUrl ? <img className="brand-logo" src={settings.logoDataUrl} alt="" /> : <ZzzLogo size={40} />}
          <div className="brand-copy">
            <strong>{brandName(settings.appName)}</strong>
            <span>Cop while you sleep · v{APP_VERSION}</span>
          </div>
        </div>
        <nav aria-label="Sections">
          {NAV.map((item) => {
            const label = deskText(lang, item.label)
            const locked = item.id === "aco" && signedIn && !features.includes("aco")
            return (
              <a key={item.id} href={`#${item.id}`} className={locked ? "locked" : undefined} aria-current={page === item.id ? "page" : undefined} aria-label={locked ? `${label} (locked)` : label} title={locked ? `${label} · locked on this license` : label}>
                <NavIcon name={item.icon} />
                <span className="nav-text">{label}</span>
                {locked ? <span className="nav-lock" aria-hidden="true">🔒</span> : null}
              </a>
            )
          })}
        </nav>
        <footer>
          <div className="bot-status" title="Bot status">
            <span className="status-dot" aria-hidden="true" />
            <span className="nav-text"><span className="bot-status-label">Bot Status</span><strong>{signedIn ? "Running" : "Signed out"}</strong></span>
          </div>
          <TopClock />
          <button type="button" className="icon-btn" title={rail ? deskText(lang, "showNames") : deskText(lang, "iconsOnly")} onClick={() => { const next = !rail; setRail(next); try { localStorage.setItem("tcgaio-rail", next ? "icons" : "open") } catch { /* keep the choice for this session */ } }}>{rail ? "»" : "«"}</button>
        </footer>
      </aside>
      <main>
        {update && update.status !== "idle" && update.status !== "current" ? (
          <div className="card update-banner">
            <ZzzLogo size={40} />
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
        {booting ? <section className="page splash" aria-busy="true" aria-label="Loading"><BrandLockup size={72} /><div className="skeleton sk-title" /><div className="skeleton sk-card" /></section> : null}
        {!booting && !signedIn && !pending ? <AccountGate lang={lang} settings={settings} onSettings={(next) => { setSettings(next); applyTheme(next) }} onDone={setAccount} /> : null}
        {!booting && pending && account ? <WaitingAccount lang={lang} account={account} onReady={setAccount} onSignedOut={() => setAccount(null)} /> : null}
        {!booting && signedIn && wizard ? <Wizard lang={lang} onDone={(next) => { setSettings(next); applyTheme(next); document.title = brandName(next.appName); setWizard(false); go("home") }} /> : null}
        {!booting && signedIn && !wizard && page === "home" ? <DashboardPage lang={lang} onTasks={() => go("tasks")} /> : null}
        {!booting && signedIn && !wizard && page === "tasks" ? <TasksPage lockedKind={tab === "monitor" || tab === "checkout" ? tab : ""} /> : null}
        {!booting && signedIn && !wizard && page === "profiles" ? <section className="page"><ProfilesPage /></section> : null}
        {!booting && signedIn && !wizard && page === "proxies" ? <section className="page"><ProxiesPage /></section> : null}
        {!booting && signedIn && !wizard && page === "accounts" ? <section className="page"><AccountsPage /></section> : null}
        {!booting && signedIn && !wizard && page === "aco" ? <AcoPage unlocked={features.includes("aco")} advanced={tab === "advanced"} /> : null}
        {!booting && signedIn && !wizard && page === "settings" ? <SettingsTabs tab={tab || "general"} lang={lang} onSettings={setSettings} /> : null}
      </main>
      {win ? <SuccessScreen win={win} sound={settings.successSound} onSound={(on) => void setSound(on)} onClose={() => setWin(null)} /> : null}
      <UpdatePrompt update={update} onUpdate={setUpdate} />
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

function SettingsTabs({ tab, lang, onSettings }: { tab: string; lang: "en" | "es"; onSettings: (next: Settings) => void }) {
  const items = [
    ["general", deskText(lang, "setGeneral")],
    ["logs", deskText(lang, "setLogs")],
    ["stores", deskText(lang, "storeDefaults")],
    ["phone", deskText(lang, "setPhone")],
    ["alerts", deskText(lang, "setAlerts")],
    ["drops", deskText(lang, "setDrops")],
    ["stats", deskText(lang, "setStats")],
    ["ship", deskText(lang, "setShip")],
    ["autopilot", deskText(lang, "setAutopilot")],
    ["keeper", deskText(lang, "setKeeper")],
    ["vault", deskText(lang, "setVault")]
  ] as const
  const advanced = items.filter(([id]) => id !== "general")
  const inAdvanced = tab !== "general" && tab !== "advanced"
  const tools = (
    <details className="advanced" open={inAdvanced}>
      <summary>More tools: logs, store defaults, phone, alerts, drops, stats</summary>
      <div className="segments scroll-x" role="tablist">
        {advanced.map(([id, label]) => <a key={id} href={`#settings/${id}`} aria-current={tab === id ? "page" : undefined}>{label}</a>)}
      </div>
    </details>
  )
  return (
    <section className="page">
      {inAdvanced ? <div className="segments" role="tablist"><a href="#settings">← {deskText(lang, "setGeneral")}</a></div> : null}
      {inAdvanced ? tools : null}
      {tab === "logs" ? <LogsPage /> : null}
      {tab === "stores" ? <StoresTab onSettings={onSettings} /> : null}
      {tab === "phone" ? <PhonePage /> : null}
      {tab === "alerts" ? <AlertsPage /> : null}
      {tab === "drops" ? <DropsPage /> : null}
      {tab === "stats" ? <AnalyticsPage /> : null}
      {tab === "ship" ? <ShipmentsPage /> : null}
      {tab === "autopilot" ? <AutopilotPage /> : null}
      {tab === "keeper" ? <KeeperPage /> : null}
      {tab === "vault" ? <VaultPage /> : null}
      {tab === "general" || tab === "advanced" || !items.some(([id]) => id === tab) ? <SettingsPage tools={<div className="segments scroll-x" role="tablist" aria-label="More tools">{advanced.map(([id, label]) => <a key={id} href={`#settings/${id}`}>{label}</a>)}</div>} /> : null}
    </section>
  )
}

function StoresTab({ onSettings }: { onSettings: (next: Settings) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    void unwrap(window.aio.settings.get()).then((payload) => setSettings(payload.settings)).catch(() => undefined)
  }, [])
  if (!settings) return null
  return (
    <>
      <StoreDefaults settings={settings} onSaved={(next) => { setSettings(next); onSettings(next); window.dispatchEvent(new CustomEvent("tcgaio-settings", { detail: next })) }} />
      <ModulesPage />
    </>
  )
}

function NavIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={NAV_PATH[name] ?? NAV_PATH.home} />
    </svg>
  )
}


function brandName(saved: string | undefined): string {
  const name = (saved ?? "").trim()
  return !name || name === "TCGAIO" ? "Zzz AIO" : name
}

function TopClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <span className="top-clock">{now.toLocaleTimeString()}</span>
}
