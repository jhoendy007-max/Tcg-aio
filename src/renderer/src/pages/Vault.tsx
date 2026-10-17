import { useEffect, useState } from "react"
import { storeName } from "../../../shared/stores"
import type { PublicVault } from "../../../shared/types"
import { Banner } from "../components/ui"
import { errorText, unwrap } from "../lib"

function when(ts: number | null): string {
  if (!ts) return "—"
  return new Date(ts).toLocaleString([], { hour12: false, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function flagLabel(flag: PublicVault["flag"]): string {
  if (flag === "expiring") return "Expiring soon"
  if (flag === "logged-out") return "Logged out"
  return "Signed in"
}

export function VaultPage() {
  const [rows, setRows] = useState<PublicVault[]>([])
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")

  async function reload() {
    setRows(await unwrap(window.aio.vault.list()))
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
  }, [])

  async function unlink(row: PublicVault) {
    setError("")
    setMessage("")
    try {
      setRows(await unwrap(window.aio.vault.unlink(row.deviceId, row.accountId)))
      setMessage(`${row.label} is no longer linked to ${row.deviceName}.`)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function twoWay(row: PublicVault, enabled: boolean) {
    setError("")
    try {
      setRows(await unwrap(window.aio.vault.setTwoWay(row.deviceId, row.accountId, enabled)))
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Session Sync</h1>
          <p>Sessions saved from your own browser stay encrypted on this PC. The extension only reads a store after you link that account. Revoke the browser from the Phone page to stop it.</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      <div className="table-wrap card">
        <table>
          <thead>
            <tr>
              <th>Store</th>
              <th>Account</th>
              <th>Browser</th>
              <th>Expires</th>
              <th>Last used</th>
              <th>Two-way</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="empty">No browser is linked. Install Session Sync, pair it from the Phone page, and link each account.</td></tr>
            ) : rows.map((row) => (
              <tr key={`${row.deviceId}-${row.accountId}`}>
                <td>{storeName(row.store)}</td>
                <td>{row.label}</td>
                <td>{row.deviceName}</td>
                <td>{when(row.expiresAt)}</td>
                <td>{when(row.lastUsedAt)}</td>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={row.twoWay} onChange={(event) => void twoWay(row, event.target.checked)} />
                    <span>{row.twoWay ? "On" : "Off"}</span>
                  </label>
                </td>
                <td className={row.flag === "ok" ? "flag-ok" : row.flag === "expiring" ? "flag-expiring" : "flag-out"}>{flagLabel(row.flag)}</td>
                <td className="row-actions"><button type="button" onClick={() => void unlink(row)}>Unlink</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
