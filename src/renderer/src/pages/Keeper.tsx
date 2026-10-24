import { useEffect, useState } from "react"
import { consistencyText } from "../../../shared/consistency"
import { DEFAULT_SETTINGS, type PublicAccount, type Settings, type StoreInfo } from "../../../shared/types"
import { Banner, Field, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function KeeperPage() {
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [stores, setStores] = useState<StoreInfo[]>([])
  const [form, setForm] = useState<Settings>(DEFAULT_SETTINGS)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")

  async function reload() {
    const [nextAccounts, nextStores, settings] = await Promise.all([
      unwrap(window.aio.accounts.list()),
      unwrap(window.aio.stores.list()),
      unwrap(window.aio.settings.get())
    ])
    setAccounts(nextAccounts)
    setStores(nextStores)
    setForm(settings.settings)
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError("")
    setMessage("")
    try {
      const next = await unwrap(window.aio.settings.save(form))
      setForm(next.settings)
      setMessage("Session Keeper saved.")
    } catch (err) {
      setError(errorText(err))
    }
  }

  const names = new Map(stores.map((store) => [store.id, store.name]))
  const saved = accounts.filter((account) => account.sessionState === "saved").length
  const expired = accounts.filter((account) => account.sessionState === "expired").length

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Session Keeper</h1>
          <p>{consistencyText(form.language === "es" ? "es" : "en", "warmupNote")}</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      <form className="card form-grid" onSubmit={save}>
        <label className="check span-2">
          <input type="checkbox" checked={form.sessionWarmup} onChange={(event) => setForm({ ...form, sessionWarmup: event.target.checked })} />
          <span>Session Keeper on. Every saved session is opened on the interval below. A drop can also warm accounts before its start time.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.warmOnStart} onChange={(event) => setForm({ ...form, warmOnStart: event.target.checked })} />
          <span>Also warm an account when its monitor or checkout starts, if the last warm-up is older than the interval.</span>
        </label>
        <Field label="Keep-alive interval (minutes)" hint="10–240. Default 30.">
          <TextInput type="number" min={10} max={240} value={form.sessionWarmupMin} onChange={(event) => setForm({ ...form, sessionWarmupMin: Number(event.target.value) })} required />
        </Field>
        <div className="stat"><strong>{saved}</strong><span>signed in</span></div>
        <div className="stat"><strong>{expired}</strong><span>need a sign-in</span></div>
        <div className="actions span-2"><button className="primary" type="submit">Save Session Keeper</button></div>
      </form>
      <div className="table-wrap card">
        <table>
          <thead><tr><th>Store</th><th>Account</th><th>Session</th><th></th></tr></thead>
          <tbody>
            {accounts.length === 0 ? <tr><td colSpan={4} className="empty">No accounts yet.</td></tr> : accounts.map((account) => (
              <tr key={account.id}>
                <td>{names.get(account.store) ?? account.store}</td>
                <td>{account.label}</td>
                <td>{consistencyText(form.language === "es" ? "es" : "en", account.freshness ?? "missing")}{account.lastWarmAt ? <div className="detail">{new Date(account.lastWarmAt).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}</div> : null}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => void unwrap(window.aio.accounts.openBrowser(account.id)).catch((err) => setError(errorText(err)))}>Sign in</button>
                  <button type="button" title="Target rejected the window? Sign in with your own browser, then use Session-Sync or Save cookies." onClick={() => void unwrap(window.aio.accounts.openInMyBrowser(account.id)).catch((err) => setError(errorText(err)))}>Open in my browser</button>
                  <button type="button" onClick={() => void unwrap(window.aio.accounts.captureBrowser(account.id)).then(() => reload()).catch((err) => setError(errorText(err)))}>Save cookies</button>
                  <button type="button" onClick={() => void unwrap(window.aio.accounts.warm(account.id)).then((result) => { setMessage(result.detail); return reload() }).catch((err) => setError(errorText(err)))}>Warm now</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
