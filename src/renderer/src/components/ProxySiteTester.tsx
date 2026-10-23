import { useState } from "react"
import { STORE_SITES } from "../../../shared/store-sites"
import type { MonitorProbeResult, ProxySiteResult, StoreId } from "../../../shared/types"
import { errorText, unwrap } from "../lib"
import { StoreSelect, type StoreChoice } from "./StoreSelect"

const CUSTOM = "custom"

const SITE_LABEL: Record<ProxySiteResult["verdict"], string> = { works: "Works", blocked: "Blocked", timeout: "Timeout", error: "Error" }
const MONITOR_LABEL: Record<MonitorProbeResult["verdict"], string> = { in: "In stock", oos: "Out of stock", blocked: "Blocked", timeout: "Timeout", "parse-error": "Parse error", error: "Error" }

function tone(verdict: string): "good" | "bad" | "slow" | "info" {
  if (verdict === "works" || verdict === "in" || verdict === "oos") return "good"
  if (verdict === "timeout") return "slow"
  if (verdict === "parse-error") return "info"
  return "bad"
}

export function msText(ms: number | null): string {
  return ms == null ? "—" : `${Math.round(ms)} ms`
}

/** Stellar-style proxy tester: pick a store's website (or a custom URL), test every proxy in the group. */
export function ProxySiteTester({ groupId, stores }: { groupId: string; stores: StoreChoice[] }) {
  const [site, setSite] = useState<string>(stores[0]?.id ?? "target")
  const [custom, setCustom] = useState("https://")
  const [siteRows, setSiteRows] = useState<ProxySiteResult[] | null>(null)
  const [monitorRows, setMonitorRows] = useState<MonitorProbeResult[] | null>(null)
  const [busy, setBusy] = useState<"" | "site" | "monitor">("")
  const [error, setError] = useState("")
  const choices: StoreChoice[] = [...stores, { id: CUSTOM, name: "Custom URL" }]
  const isCustom = site === CUSTOM
  const url = isCustom ? custom : STORE_SITES[site as StoreId] ?? ""

  async function runSite() {
    setBusy("site"); setError(""); setMonitorRows(null)
    try { setSiteRows(await unwrap(window.aio.proxies.siteTest(groupId, url))) } catch (err) { setError(errorText(err)) } finally { setBusy("") }
  }

  async function runMonitor() {
    setBusy("monitor"); setError(""); setSiteRows(null)
    try { setMonitorRows(await unwrap(window.aio.proxies.monitorTest(groupId, site as StoreId))) } catch (err) { setError(errorText(err)) } finally { setBusy("") }
  }

  const rows = siteRows ?? monitorRows
  const works = siteRows ? siteRows.filter((row) => row.verdict === "works").length : monitorRows ? monitorRows.filter((row) => row.verdict === "in" || row.verdict === "oos").length : 0
  const times = (rows ?? []).map((row) => row.ms).filter((ms): ms is number => ms != null).sort((a, b) => a - b)
  const median = times.length ? times[Math.floor(times.length / 2)] : null

  return (
    <div className="site-tester">
      <div className="site-tester-bar">
        <div className="site-pick"><StoreSelect label="Website" value={site} stores={choices} onChange={setSite} /></div>
        {isCustom ? <input className="site-url" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="https://example.com/" aria-label="Custom website URL" /> : <span className="site-url muted" title={url}>{url.replace(/^https:\/\//, "")}</span>}
        <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void runSite()}>{busy === "site" ? "Testing…" : "Test"}</button>
        <button type="button" disabled={Boolean(busy) || isCustom} title="Runs the store's stock check on a real Pokemon TCG product through each proxy" onClick={() => void runMonitor()}>{busy === "monitor" ? "Checking stock…" : "Test monitor"}</button>
      </div>
      {error ? <div className="banner error">{error}</div> : null}
      {rows ? (
        <>
          <div className="site-summary">
            <span><b>{works}</b>/{rows.length} {siteRows ? "work" : "read stock"}</span>
            <span>median <b>{msText(median)}</b></span>
            <span className="muted">{siteRows ? url.replace(/^https:\/\//, "") : `${monitorRows?.[0]?.storeName ?? ""} stock check`}</span>
          </div>
          <table className="site-results">
            <thead><tr><th>Proxy</th><th>Result · speed</th><th>Details</th></tr></thead>
            <tbody>
              {siteRows ? siteRows.map((row) => (
                <tr key={row.proxyId}>
                  <td className="mono">{row.label}</td>
                  <td className="result-cell"><span className={`verdict ${tone(row.verdict)}`}>{SITE_LABEL[row.verdict]}</span><span className="ms">{msText(row.ms)}</span></td>
                  <td className="muted">{row.detail}</td>
                </tr>
              )) : monitorRows!.map((row) => (
                <tr key={row.proxyId}>
                  <td className="mono">{row.label}</td>
                  <td className="result-cell"><span className={`verdict ${row.verdict === "in" ? "good" : row.verdict === "oos" ? "oos" : tone(row.verdict)}`}>{MONITOR_LABEL[row.verdict]}</span><span className="ms">{msText(row.ms)}</span></td>
                  <td className="muted">{row.title ? `${row.title} · ` : ""}{row.detail}{row.status != null ? ` · HTTP ${row.status}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  )
}
