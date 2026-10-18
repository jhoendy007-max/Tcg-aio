import { useEffect, useState } from "react"
import type { AnalyticsReport, PublicTask } from "../../../shared/types"
import { storeName } from "../../../shared/stores"
import { Banner } from "../components/ui"
import { errorText, formatTime, unwrap } from "../lib"

export function LogsPage() {
  const [tasks, setTasks] = useState<PublicTask[] | null>(null)
  const [report, setReport] = useState<AnalyticsReport | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    void Promise.all([unwrap(window.aio.tasks.list()), unwrap(window.aio.analytics.get())])
      .then(([nextTasks, nextReport]) => {
        setTasks(nextTasks)
        setReport(nextReport)
      })
      .catch((err) => setError(errorText(err)))
  }, [])

  const lines = (tasks ?? []).flatMap((task) => task.logs.slice(-4).map((line) => ({
    key: `${task.id}-${line.ts}-${line.message}`,
    at: line.ts,
    level: line.level,
    text: `${storeName(task.store)} · ${task.sku || "monitor"} · ${line.message}`
  }))).sort((a, b) => b.at - a.at).slice(0, 40)

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Logs</h1>
          <p>Live task activity, plus success and decline history from the PC.</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className="card log-card">
        <div className="log-head"><h2>Activity</h2><span>{lines.length} lines</span></div>
        <div className="log">
          {lines.length === 0 ? <div className="empty">Logs show up after a task runs.</div> : lines.map((line) => (
            <div key={line.key} className={`log-line ${line.level}`}>
              <time>{formatTime(line.at)}</time>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="card table-wrap">
        <div className="log-head"><h2>Success and declines</h2></div>
        <table>
          <thead><tr><th>When</th><th>Store</th><th>SKU</th><th>Result</th><th>Price</th></tr></thead>
          <tbody>
            {(report?.recent ?? []).length === 0 ? <tr><td colSpan={5} className="empty">No checkout history yet.</td></tr> : report?.recent.map((row) => (
              <tr key={`${row.id}-${row.at}`}>
                <td>{formatTime(row.at)}</td>
                <td>{storeName(row.store)}</td>
                <td>{row.sku}</td>
                <td><span className={`pill ${row.outcome}`}>{row.outcome}</span></td>
                <td>{row.price == null ? "—" : `$${row.price.toFixed(2)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
