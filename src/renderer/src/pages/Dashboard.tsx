import { useEffect, useState } from "react"
import { deskText } from "../../../shared/desk-ui"
import { todayCheckoutStats } from "../../../shared/desk"
import { isActiveStatus, type AnalyticsReport, type ProxyScore, type PublicAccount, type PublicTask } from "../../../shared/types"
import { storeName } from "../../../shared/stores"
import { ProductVisual } from "../components/marks"
import { Banner } from "../components/ui"
import { errorText, STATUS_LABEL, unwrap } from "../lib"

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
    setTasks(nextTasks)
    setReport(nextReport)
    setScores(nextScores)
    setAccounts(nextAccounts)
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
  const active = tasks.filter((task) => isActiveStatus(task.status)).length
  const today = todayCheckoutStats(report.recent, now)
  const benched = scores.filter((score) => score.benchedUntil > now).length
  const saved = accounts.filter((account) => account.sessionState === "saved").length
  const expired = accounts.filter((account) => account.sessionState === "expired").length
  const missing = accounts.filter((account) => account.sessionState === "missing").length

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>{deskText(lang, "navHome")}</h1>
          <p>{active} running · {saved} signed in · {expired} expired · {missing} missing{benched ? ` · ${benched} proxies resting` : ""}</p>
        </div>
        <button type="button" className="primary" onClick={onTasks}>{deskText(lang, "navTasks")}</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className="chips">
        <span className="chip"><strong>{active}</strong> {deskText(lang, "chipRunning")}</span>
        <span className="chip ok"><strong>{today.success}</strong> {deskText(lang, "chipCheckouts")}</span>
        <span className="chip bad"><strong>{today.failure}</strong> {deskText(lang, "chipDeclines")}</span>
        <span className="chip"><strong>${today.spend.toFixed(0)}</strong> {deskText(lang, "chipSpend")}</span>
        <span className="chip"><strong>{Math.round(today.winRate * 100)}%</strong> {deskText(lang, "chipSuccess")}</span>
      </div>
      {tasks.length === 0 ? (
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
            {report.recent.length === 0 ? <tr><td className="empty">Checkouts show up here after a task runs.</td></tr> : report.recent.slice(0, 6).map((row) => (
              <tr key={`${row.id}-${row.at}`}>
                <td>{storeName(row.store)} · {row.sku}</td>
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
            {tasks.length === 0 ? <tr><td colSpan={2} className="empty">No tasks yet. The setup wizard or the Tasks page can add a test-mode task.</td></tr> : tasks.slice(0, 8).map((task) => (
              <tr key={task.id}>
                <td>
                  <div className="product-cell">
                    <ProductVisual store={task.store} name={storeName(task.store)} sku={task.sku} imageUrl={task.imageUrl} />
                    <div>
                      <div>{storeName(task.store)}</div>
                      <div className="detail">{task.sku}</div>
                    </div>
                  </div>
                </td>
                <td><span className={`pill ${task.status}`}>{STATUS_LABEL[task.status]}</span></td>
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
