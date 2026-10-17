import { useEffect, useState } from "react"
import type { AnalyticsReport } from "../../../shared/types"
import { formatAst } from "../../../engine/time"
import { SpeedChart, SpendChart, WinChart } from "../components/charts"
import { Banner } from "../components/ui"
import { errorText, unwrap } from "../lib"

const empty: AnalyticsReport = {
  attempts: 0, success: 0, failure: 0, paused: 0, tested: 0, winRate: 0, spend: 0, byStore: [], byProduct: [], timeline: [], recent: [],
  monitor: { samples: 0, blocked: 0, blockRate: 0, avgMs: 0, byStore: [] },
  restockHints: []
}

export function AnalyticsPage() {
  const [report, setReport] = useState<AnalyticsReport>(empty)
  const [error, setError] = useState("")

  useEffect(() => {
    void unwrap(window.aio.analytics.get()).then(setReport).catch((err) => setError(errorText(err)))
  }, [])

  async function download() {
    const file = await unwrap(window.aio.analytics.csv())
    const blob = new Blob([file.csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "tcgaio-checkouts.csv"
    link.click()
    URL.revokeObjectURL(url)
  }

  const max = Math.max(1, ...report.timeline.map((point) => point.success + point.failure + point.paused))

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>Checkout history on this PC. Win rate is successes divided by successes, failures, and pauses. Test runs are counted separately and are not spend.</p>
        </div>
        <button type="button" onClick={() => void download().catch((err) => setError(errorText(err)))}>Export CSV</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className="stats">
        <div className="stat"><strong>{Math.round(report.winRate * 100)}%</strong><span>win rate</span></div>
        <div className="stat"><strong>${report.spend.toFixed(2)}</strong><span>recorded spend</span></div>
        <div className="stat"><strong>{report.success}</strong><span>success</span></div>
        <div className="stat"><strong>{report.failure}</strong><span>failed</span></div>
        <div className="stat"><strong>{report.paused}</strong><span>paused</span></div>
        <div className="stat"><strong>{report.tested}</strong><span>tested</span></div>
        <div className="stat"><strong>{report.monitor.avgMs} ms</strong><span>avg monitor</span></div>
        <div className="stat"><strong>{Math.round(report.monitor.blockRate * 100)}%</strong><span>monitor block rate</span></div>
      </div>
      <div className="card">
        <h2>Monitor</h2>
        <p className="hint">{report.monitor.samples} stock reads · {report.monitor.blocked} blocked · average {report.monitor.avgMs} ms.</p>
        {report.monitor.byStore.length === 0 ? null : report.monitor.byStore.map((row) => (
          <p key={row.store} className="hint">{row.store} · {row.samples} reads · {Math.round(row.blockRate * 100)}% blocked · {row.avgMs} ms</p>
        ))}
        {report.restockHints.length === 0 ? <p className="hint">Restock times show up here after the same SKU comes back at least twice in the same hour.</p> : report.restockHints.map((hint) => (
          <p key={`${hint.store}:${hint.sku}:${hint.hourAst}`} className="hint">{hint.detail}</p>
        ))}
      </div>
      <div className="chart-grid">
        <div className="card">
          <h2>Wins over time</h2>
          {report.timeline.length === 0 ? <p className="hint">No checkouts recorded yet.</p> : <WinChart points={report.timeline} />}
        </div>
        <div className="card">
          <h2>Spend per store</h2>
          <SpendChart rows={report.byStore.map((row) => ({ name: row.storeName, spend: row.spend }))} />
        </div>
      </div>
      <div className="card">
        <h2>Monitor speed</h2>
        <SpeedChart rows={report.monitor.byStore.map((row) => ({ name: row.store, ms: row.avgMs }))} />
      </div>
      <div className="card">
        <h2>Timeline</h2>
        {report.timeline.length === 0 ? <p className="hint">No checkouts recorded yet.</p> : (
          <div className="bars" aria-label="Checkouts by day">
            {report.timeline.slice(-14).map((point) => (
              <div key={point.day} className="bar-col">
                <div className="bar-stack">
                  <div className="bar ok" style={{ height: `${(point.success / max) * 88}px` }} />
                  <div className="bar bad" style={{ height: `${(point.failure / max) * 88}px` }} />
                  <div className="bar wait" style={{ height: `${(point.paused / max) * 88}px` }} />
                </div>
                <span>{point.day.slice(5)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="table-wrap card">
        <table>
          <thead><tr><th>Store</th><th>Success</th><th>Failed</th><th>Paused</th><th>Tested</th><th>Spend</th></tr></thead>
          <tbody>
            {report.byStore.length === 0 ? <tr><td colSpan={6} className="empty">No store totals yet.</td></tr> : report.byStore.map((row) => (
              <tr key={row.store}><td>{row.storeName}</td><td>{row.success}</td><td>{row.failure}</td><td>{row.paused}</td><td>{row.tested}</td><td>${row.spend.toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap card">
        <table>
          <thead><tr><th>Product</th><th>Success</th><th>Failed</th><th>Paused</th><th>Spend</th></tr></thead>
          <tbody>
            {report.byProduct.length === 0 ? <tr><td colSpan={5} className="empty">No product totals yet.</td></tr> : report.byProduct.map((row) => (
              <tr key={`${row.store}-${row.sku}`}><td className="sku">{row.product}</td><td>{row.success}</td><td>{row.failure}</td><td>{row.paused}</td><td>${row.spend.toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap card">
        <table>
          <thead><tr><th>When</th><th>Store</th><th>Product</th><th>Price</th><th>Result</th></tr></thead>
          <tbody>
            {report.recent.length === 0 ? <tr><td colSpan={5} className="empty">History appears after a task finishes.</td></tr> : report.recent.map((row) => (
              <tr key={row.id}><td>{formatAst(row.at)}</td><td>{row.store}</td><td className="sku">{row.sku}</td><td>{row.price === null ? "—" : `$${row.price.toFixed(2)}`}</td><td>{row.outcome}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
