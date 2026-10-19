import { useEffect, useState } from "react"
import { clientIdOf, clientText, type Client } from "../../../shared/clients"
import type { AnalyticsReport, CheckoutRecord, InventoryReport, ResaleQuote } from "../../../shared/types"
import { formatAst } from "../../../engine/time"
import { SpeedChart, SpendChart, WinChart } from "../components/charts"
import { Banner, Field, Select } from "../components/ui"
import { errorText, unwrap } from "../lib"

const empty: AnalyticsReport = {
  attempts: 0, success: 0, failure: 0, paused: 0, tested: 0, winRate: 0, spend: 0, byStore: [], byProduct: [], timeline: [], recent: [],
  monitor: { samples: 0, blocked: 0, blockRate: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, byStore: [] },
  stockLog: [],
  restockHints: []
}

export function AnalyticsPage() {
  const [report, setReport] = useState<AnalyticsReport>(empty)
  const [clients, setClients] = useState<Client[]>([])
  const [clientFilter, setClientFilter] = useState("")
  const [lang, setLang] = useState<"en" | "es">("en")
  const [error, setError] = useState("")

  useEffect(() => {
    void Promise.all([
      unwrap(window.aio.analytics.get()),
      unwrap(window.aio.clients.list()),
      unwrap(window.aio.settings.get())
    ]).then(([nextReport, nextClients, settings]) => {
      setReport({
        ...empty,
        ...(nextReport ?? {}),
        monitor: { ...empty.monitor, ...(nextReport?.monitor ?? {}), byStore: nextReport?.monitor?.byStore ?? [] },
        timeline: nextReport?.timeline ?? [],
        byStore: nextReport?.byStore ?? [],
        byProduct: nextReport?.byProduct ?? [],
        recent: nextReport?.recent ?? [],
        restockHints: nextReport?.restockHints ?? [],
        stockLog: nextReport?.stockLog ?? []
      })
      setClients(Array.isArray(nextClients) ? nextClients : [])
      setLang(settings?.settings?.language === "es" ? "es" : "en")
    }).catch((err) => setError(errorText(err)))
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
  const clientName = new Map(clients.map((client) => [client.id, client.name]))
  const recent = report.recent.filter((row) => !clientFilter || clientIdOf(row.clientId) === clientFilter)

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>Checkout history on this PC. Win rate is successes divided by successes, failures, and pauses. Test runs are counted separately and are not spend.</p>
        </div>
        <button type="button" onClick={() => void download().catch((err) => setError(errorText(err)))}>Export CSV</button>
      </header>
      <div className="card toolbar">
        <Field label={clientText(lang, "filter")}>
          <Select value={clientFilter} onChange={(event) => setClientFilter(event.target.value)} aria-label={clientText(lang, "filter")}>
            <option value="">{clientText(lang, "allClients")}</option>
            {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
          </Select>
        </Field>
      </div>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className="stats">
        <div className="stat"><strong>{Math.round(report.winRate * 100)}%</strong><span>win rate</span></div>
        <div className="stat"><strong>${report.spend.toFixed(2)}</strong><span>recorded spend</span></div>
        <div className="stat"><strong>{report.success}</strong><span>success</span></div>
        <div className="stat"><strong>{report.failure}</strong><span>failed</span></div>
        <div className="stat"><strong>{report.paused}</strong><span>paused</span></div>
        <div className="stat"><strong>{report.tested}</strong><span>tested</span></div>
        <div className="stat"><strong>{report.monitor.avgMs} ms</strong><span>avg monitor</span></div>
        <div className="stat"><strong>{report.monitor.p50Ms} ms</strong><span>monitor p50</span></div>
        <div className="stat"><strong>{report.monitor.p95Ms} ms</strong><span>monitor p95</span></div>
        <div className="stat"><strong>{Math.round(report.monitor.blockRate * 100)}%</strong><span>monitor block rate</span></div>
      </div>
      <div className="card">
        <h2>Monitor</h2>
        <p className="hint">{report.monitor.samples} stock reads · {report.monitor.blocked} blocked · average {report.monitor.avgMs} ms · p50 {report.monitor.p50Ms} ms · p95 {report.monitor.p95Ms} ms.</p>
        {report.monitor.byStore.length === 0 ? null : report.monitor.byStore.map((row) => (
          <p key={row.store} className="hint">{row.store} · {row.samples} reads · {Math.round(row.blockRate * 100)}% blocked · avg {row.avgMs} ms · p50 {row.p50Ms} ms · p95 {row.p95Ms} ms</p>
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
        <SpeedChart rows={report.monitor.byStore.map((row) => ({ name: row.store, ms: row.p50Ms }))} />
      </div>
      <div className="table-wrap card">
        <h2>Stock changes</h2>
        {report.stockLog.length === 0 ? <p className="hint">Price, restock, and sell-out notes show up after a monitor sees a change.</p> : (
          <table>
            <thead><tr><th>When</th><th>Store</th><th>SKU</th><th>Change</th><th>Price</th></tr></thead>
            <tbody>
              {report.stockLog.map((row, index) => (
                <tr key={`${row.at}-${row.sku}-${index}`}>
                  <td>{formatAst(row.at)}</td>
                  <td>{row.store}</td>
                  <td className="sku">{row.sku}</td>
                  <td>{row.kind ?? "restock"}{row.title ? ` · ${row.title}` : ""}</td>
                  <td>{row.price === null ? "—" : `$${row.price.toFixed(2)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
      <ResaleCard wins={report.recent.filter((row) => row.outcome === "success")} />
      <InventoryCard />
      <div className="table-wrap card">
        <table>
          <thead><tr><th>When</th><th>{clientText(lang, "filter")}</th><th>Store</th><th>Product</th><th>Price</th><th>Result</th></tr></thead>
          <tbody>
            {recent.length === 0 ? <tr><td colSpan={6} className="empty">History appears after a task finishes.</td></tr> : recent.map((row) => (
              <tr key={row.id}><td>{formatAst(row.at)}</td><td>{clientName.get(clientIdOf(row.clientId)) ?? clientText(lang, "me")}</td><td>{row.store}</td><td className="sku">{row.sku}</td><td>{row.price === null ? "—" : `$${row.price.toFixed(2)}`}</td><td>{row.outcome}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ResaleCard({ wins }: { wins: CheckoutRecord[] }) {
  const [picked, setPicked] = useState("")
  const [title, setTitle] = useState("")
  const [cost, setCost] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [feePct, setFeePct] = useState("0")
  const [tcgProductId, setTcgProductId] = useState("")
  const [quote, setQuote] = useState<ResaleQuote | null>(null)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)

  function applyWin(id: string) {
    setPicked(id)
    const row = wins.find((item) => item.id === id)
    if (!row) return
    setTitle(row.product || row.sku)
    setCost(row.price === null ? "" : String(row.price))
    setQuantity(String(row.quantity && row.quantity > 0 ? row.quantity : 1))
    setTcgProductId(row.store === "tcgplayer" ? tcgId(row.sku) : "")
    setQuote(null)
  }

  async function check() {
    setError("")
    setCopied(false)
    const paid = cost.trim() === "" ? null : Number(cost)
    if (paid !== null && !Number.isFinite(paid)) throw new Error("Cost must be a dollar amount.")
    const next = await unwrap(window.aio.resale.quote({
      title,
      cost: paid,
      quantity: Number(quantity) || 1,
      feePct: Number(feePct) || 0,
      tcgProductId
    }))
    setQuote(next)
  }

  async function copyDraft() {
    if (!quote) return
    await navigator.clipboard.writeText(quote.draft)
    setCopied(true)
  }

  return (
    <div className="card">
      <h2>Resale</h2>
      <p className="hint">After a win, this reads the public TCGplayer market price and the public eBay sold search, then drafts a listing. It does not post the listing.</p>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className="form-grid">
        <Field label="Win" hint="Fills the name and recorded price. You can edit both.">
          <select value={picked} onChange={(event) => applyWin(event.target.value)}>
            <option value="">Custom</option>
            {wins.map((row) => <option key={row.id} value={row.id}>{row.product || row.sku}</option>)}
          </select>
        </Field>
        <Field label="Product name">
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Cost" hint="Total you paid. Leave blank if the win did not record a price.">
          <input value={cost} onChange={(event) => setCost(event.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Quantity">
          <input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Fee percent" hint="Zero leaves fees out of the profit. This is not an eBay or TCGplayer fee quote.">
          <input value={feePct} onChange={(event) => setFeePct(event.target.value)} inputMode="decimal" />
        </Field>
        <Field label="TCGplayer product" hint="Product id or tcgplayer.com/product URL. The catalog is public.">
          <input value={tcgProductId} onChange={(event) => setTcgProductId(event.target.value)} />
        </Field>
      </div>
      <button type="button" onClick={() => void check().catch((err) => setError(errorText(err)))}>Check prices</button>
      {quote ? (
        <div>
          <p className="hint">{quote.tcgNote}{quote.tcgMarket === null ? "" : ` $${quote.tcgMarket.toFixed(2)}.`}</p>
          <p className="hint">{quote.ebayNote}{quote.ebayMedian === null ? "" : ` $${quote.ebayMedian.toFixed(2)}.`}</p>
          <p className="hint">TCGplayer profit: {money(quote.tcgProfit)} · eBay profit: {money(quote.ebayProfit)}</p>
          <Field label="Listing draft">
            <textarea readOnly rows={8} value={quote.draft} />
          </Field>
          <button type="button" onClick={() => void copyDraft().catch((err) => setError(errorText(err)))}>{copied ? "Copied" : "Copy draft"}</button>
        </div>
      ) : null}
    </div>
  )
}

function InventoryCard() {
  const [report, setReport] = useState<InventoryReport | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    void unwrap(window.aio.inventory.get()).then(setReport).catch((err) => setError(errorText(err)))
  }, [])

  async function save(id: string, raw: string) {
    const value = raw.trim() === "" ? null : Number(raw)
    if (value !== null && !Number.isFinite(value)) throw new Error("Current value must be a dollar amount.")
    setReport(await unwrap(window.aio.inventory.setValue(id, value)))
  }

  async function download() {
    const file = await unwrap(window.aio.inventory.csv())
    const blob = new Blob([file.csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "tcgaio-inventory.csv"
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="card">
      <header className="page-head">
        <div>
          <h2>Inventory</h2>
          <p className="hint">Successful purchases on this PC. Cost is the recorded price. Current value is what you enter. Profit is value minus cost. Test runs are not purchases.</p>
        </div>
        <button type="button" onClick={() => void download().catch((err) => setError(errorText(err)))}>Export inventory CSV</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {report ? (
        <div className="stats">
          <div className="stat"><strong>{report.purchases}</strong><span>purchases</span></div>
          <div className="stat"><strong>${report.cost.toFixed(2)}</strong><span>cost</span></div>
          <div className="stat"><strong>${report.value.toFixed(2)}</strong><span>valued</span></div>
          <div className="stat"><strong>${report.profit.toFixed(2)}</strong><span>profit on valued</span></div>
          <div className="stat"><strong>{report.unvalued}</strong><span>need a value</span></div>
        </div>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Qty</th><th>Cost</th><th>Current value</th><th>Profit</th></tr></thead>
          <tbody>
            {!report || report.rows.length === 0 ? <tr><td colSpan={5} className="empty">Purchases show up after a successful checkout.</td></tr> : report.rows.map((row) => (
              <tr key={row.id}>
                <td className="sku">{row.product}</td>
                <td>{row.quantity}</td>
                <td>{money(row.cost)}</td>
                <td><input defaultValue={row.value === null ? "" : String(row.value)} inputMode="decimal" onBlur={(event) => void save(row.id, event.target.value).catch((err) => setError(errorText(err)))} /></td>
                <td>{money(row.profit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`
}

function tcgId(sku: string): string {
  const text = sku.trim()
  if (/^\d{3,12}$/.test(text)) return text
  const match = text.match(/\/product\/(\d{3,12})/)
  return match?.[1] ?? ""
}
