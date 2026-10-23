import { useEffect, useState } from "react"
import { deskText } from "../../../shared/desk-ui"
import { todayCheckoutStats } from "../../../shared/desk"
import { isActiveStatus, type AnalyticsReport, type ProxyScore, type PublicAccount, type PublicTask } from "../../../shared/types"
import { storeName } from "../../../shared/stores"
import { StoreLogo } from "../components/StoreLogo"
import { stockOfTask } from "../../../shared/stock"
import { friendlyStatus } from "./Tasks"
import { Banner } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function DashboardPage({ onTasks, lang = "en" }: { onTasks: () => void; lang?: "en" | "es" }) {
  const [tasks, setTasks] = useState<PublicTask[] | null>(null)
  const [report, setReport] = useState<AnalyticsReport | null>(null)
  const [scores, setScores] = useState<ProxyScore[] | null>(null)
  const [accounts, setAccounts] = useState<PublicAccount[] | null>(null)
  const [error, setError] = useState("")

  async function reload() {
    const [nextTasks, nextReport, nextScores, nextAccounts] = await Promise.all([
      unwrap(window.aio.tasks.list()),
      unwrap(window.aio.analytics.get()),
      unwrap(window.aio.proxies.health()),
      unwrap(window.aio.accounts.list())
    ])
    setTasks(Array.isArray(nextTasks) ? nextTasks : [])
    setReport(nextReport ?? null)
    setScores(Array.isArray(nextScores) ? nextScores : [])
    setAccounts(Array.isArray(nextAccounts) ? nextAccounts : [])
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
    const stop = window.aio.tasks.onEvent(() => { void reload().catch(() => undefined) })
    const timer = window.setInterval(() => { void reload().catch(() => undefined) }, 15000)
    return () => {
      stop()
      window.clearInterval(timer)
    }
  }, [])

  if (error && !tasks) return <section className="page"><Banner tone="error">{error}</Banner></section>
  if (!tasks || !report || !scores || !accounts) return <DashboardSkeleton />

  const now = Date.now()
  const taskList = Array.isArray(tasks) ? tasks : []
  const recent = Array.isArray(report.recent) ? report.recent : []
  const active = taskList.filter((task) => task && isActiveStatus(task.status)).length
  const today = todayCheckoutStats(recent, now)
  const benched = (Array.isArray(scores) ? scores : []).filter((score) => score && score.benchedUntil > now).length
  const accountList = Array.isArray(accounts) ? accounts : []
  const saved = accountList.filter((account) => account?.sessionState === "saved").length
  const expired = accountList.filter((account) => account?.sessionState === "expired").length
  const missing = accountList.filter((account) => account?.sessionState === "missing").length

  const proxyTotal = (Array.isArray(scores) ? scores : []).length
  const series = hourlySeries(recent, now)
  return (
    <section className="page dash">
      <header className="page-head">
        <div>
          <h1>{deskText(lang, "navHome")}</h1>
          <p>Overview of your bot performance and activity · {saved} signed in · {expired} expired · {missing} missing</p>
        </div>
        <span className="sys-pill"><span className="status-dot" aria-hidden="true" />{benched ? `${benched} proxies resting` : "All systems operational"}</span>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className="kpis">
        <Kpi icon="🛒" label={deskText(lang, "chipCheckouts")} value={String(today.success)} sub={`${today.failure} ${deskText(lang, "chipDeclines").toLowerCase()} · $${today.spend.toFixed(0)}`} />
        <Kpi icon="◎" label={deskText(lang, "chipSuccess")} value={`${Math.round(today.winRate * 100)}%`} sub="today" />
        <Kpi icon="🚀" label={deskText(lang, "chipRunning")} value={String(active)} sub={`${taskList.length} tasks total`} />
        <Kpi icon="🛡" label="Proxies online" value={`${proxyTotal - benched} / ${proxyTotal}`} sub={proxyTotal ? `${Math.round(((proxyTotal - benched) / proxyTotal) * 100)}%` : "no proxies yet"} />
      </div>
      <div className="dash-row">
        <div className="card chart-card">
          <div className="log-head"><h2>Checkouts over time</h2><span className="chip">24 hours</span></div>
          <LineChart values={series} />
        </div>
        <div className="card quick-card">
          <button type="button" className="primary big" onClick={onTasks}>＋ Create Task</button>
          <a className="quick-row" href="#tasks">⚡ Quick Task <span>›</span></a>
          <a className="quick-row" href="#tasks">⇪ Import Tasks <span>›</span></a>
          <a className="quick-row" href="#aco">✦ ACO orders <span>›</span></a>
        </div>
      </div>
      {taskList.length === 0 ? (
        <div className="card empty-next">
          <h2>{deskText(lang, "emptyTasks")}</h2>
          <p>{deskText(lang, "emptyHint")}</p>
          <button type="button" className="primary" onClick={onTasks}>{deskText(lang, "emptyNext")}</button>
        </div>
      ) : null}
      <div className="card table-wrap">
        <div className="log-head"><h2>{deskText(lang, "feed")}</h2><span>{today.success} today</span></div>
        <table>
          <tbody>
            {recent.length === 0 ? <tr><td className="empty">Checkouts show up here after a task runs.</td></tr> : recent.slice(0, 6).map((row) => (
              <tr key={`${row.id}-${row.at}`}>
                <td><span className="store-row"><StoreLogo store={row.store} /> {storeName(row.store)} · {row.sku}</span></td>
                <td className={`status-text status-${row.outcome}`}>{row.outcome === "success" || row.outcome === "tested" ? deskText(lang, "outcomeSuccess") : row.outcome === "failure" ? deskText(lang, "outcomeDeclined") : row.outcome === "paused" ? deskText(lang, "outcomeWaiting") : row.outcome}</td>
                <td>{row.price == null ? "—" : `$${row.price.toFixed(2)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card table-wrap">
        <div className="log-head"><h2>Tasks</h2><span>{active} running</span></div>
        <table>
          <thead><tr><th>Product</th><th>Status</th></tr></thead>
          <tbody>
            {taskList.length === 0 ? <tr><td colSpan={2} className="empty">No tasks yet. The setup wizard or the Tasks page can add a test-mode task.</td></tr> : taskList.slice(0, 8).map((task) => (
              <tr key={task.id}>
                <td>
                  <div className="product-cell">
                    <StoreLogo store={task.store} size={32} />
                    <div>
                      <div>{storeName(task.store)}</div>
                      <div className="detail">{task.sku}</div>
                    </div>
                  </div>
                </td>
                <td><span className={`status-pill s-${task.status}${stockOfTask(task) ? ` stock-${stockOfTask(task)}` : ""}`}>{stockOfTask(task) === "in" ? "In stock" : stockOfTask(task) === "out" ? "Out of stock" : friendlyStatus(task.status)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function DashboardSkeleton() {
  return (
    <section className="page" aria-busy="true" aria-label="Loading home">
      <div className="skeleton sk-title" />
      <div className="stats">{Array.from({ length: 6 }, (_, index) => <div key={index} className="skeleton sk-card" />)}</div>
      <div className="skeleton sk-card" />
    </section>
  )
}

function Kpi({ icon, label, value, sub }: { icon: string; label: string; value: string; sub: string }) {
  return (
    <div className="kpi card">
      <span className="kpi-icon" aria-hidden="true">{icon}</span>
      <div>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{value}</div>
        <div className="kpi-sub">{sub}</div>
      </div>
    </div>
  )
}

function hourlySeries(recent: Array<{ at: number | string; outcome: string }>, now: number): number[] {
  const buckets = Array.from({ length: 24 }, () => 0)
  for (const row of recent) {
    const at = typeof row.at === "number" ? row.at : Date.parse(String(row.at))
    if (!Number.isFinite(at) || row.outcome !== "success") continue
    const age = Math.floor((now - at) / 3_600_000)
    if (age >= 0 && age < 24) buckets[23 - age] += 1
  }
  return buckets
}

function LineChart({ values }: { values: number[] }) {
  const w = 600
  const h = 180
  values = values.reduce<number[]>((out, v, i) => (i % 2 ? (out[out.length - 1] += v, out) : [...out, v]), [])
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 12 - (v / max) * (h - 30)] as const)
  const d = pts.reduce((path, [x, y], i) => {
    if (i === 0) return `M${x},${y}`
    const [px, py] = pts[i - 1]
    const cx = (px + x) / 2
    return `${path} C${cx},${py} ${cx},${y} ${x},${y}`
  }, "")
  return (
    <svg className="line-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Checkouts per hour, last 24 hours">
      <defs>
        <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--neon-2)" stopOpacity="0.35" /><stop offset="100%" stopColor="var(--neon-1)" stopOpacity="0" /></linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} className="grid" />)}
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="url(#chartFill)" />
      <path d={d} className="line" />
    </svg>
  )
}
