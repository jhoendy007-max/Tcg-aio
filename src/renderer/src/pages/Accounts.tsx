import { useEffect, useState } from "react"
import type { AccountInput, PublicAccount, StoreId, StoreInfo } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

interface FormState {
  id?: string
  store: StoreId
  label: string
  username: string
  password: string
  session: string
  clearSession: boolean
}

const blank = (): FormState => ({
  store: "target",
  label: "",
  username: "",
  password: "",
  session: "",
  clearSession: false
})

export function AccountsPage() {
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [stores, setStores] = useState<StoreInfo[]>([])
  const [form, setForm] = useState<FormState | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function reload() {
    const [nextAccounts, nextStores] = await Promise.all([
      unwrap(window.aio.accounts.list()),
      unwrap(window.aio.stores.list())
    ])
    setAccounts(nextAccounts)
    setStores(nextStores)
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!form) return
    setBusy(true)
    setError("")
    try {
      const input: AccountInput = {
        id: form.id,
        store: form.store,
        label: form.label,
        username: form.username,
        password: form.password,
        passwordAction: form.password ? "replace" : form.id ? "keep" : "clear",
        session: form.session,
        sessionAction: form.clearSession ? "clear" : form.session.trim() ? "replace" : form.id ? "keep" : "clear"
      }
      await unwrap(window.aio.accounts.save(input))
      setForm(null)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this account?")) return
    setError("")
    try {
      await unwrap(window.aio.accounts.delete(id))
      await reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const storeName = new Map(stores.map((store) => [store.id, store.name]))

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Accounts</h1>
          <p>Use your own store login. A pasted browser session is the reliable path for Target, Walmart, Best Buy, Pokémon Center, and Crunchyroll. If sign-in hits a challenge, the task pauses for you.</p>
        </div>
        <button type="button" className="primary" onClick={() => { setForm(blank()); setError("") }}>New account</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {form ? (
        <form className="card stack" onSubmit={save}>
          <div className="form-grid">
            <Field label="Store">
              <Select value={form.store} onChange={(event) => setForm({ ...form, store: event.target.value as StoreId })}>
                {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
              </Select>
            </Field>
            <Field label="Label"><TextInput value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} required /></Field>
            <Field label="Username"><TextInput type="email" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required /></Field>
            <Field label="Password" hint={form.id ? "Leave blank to keep the saved password." : "Optional when a session is pasted."}>
              <TextInput type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
            </Field>
          </div>
          <Field label="Browser session" hint="Target: accessToken, visitorId, and refreshToken. Walmart: auth and CID. Best Buy: the www.bestbuy.com cookie header, including at. Pokémon Center: the full www.pokemoncenter.com cookie header. Crunchyroll: the www.crunchyroll.com cookie header or the shopper access token. Cookie strings or the same fields as JSON. Leave blank to keep a saved session.">
            <textarea value={form.session} onChange={(event) => setForm({ ...form, session: event.target.value, clearSession: false })} rows={5} spellCheck={false} placeholder="accessToken=...; visitorId=...   or   auth=...; CID=...   or   at=...; vt=..." />
          </Field>
          {form.id ? (
            <label className="check">
              <input type="checkbox" checked={form.clearSession} onChange={(event) => setForm({ ...form, clearSession: event.target.checked, session: event.target.checked ? "" : form.session })} />
              <span>Remove the saved session</span>
            </label>
          ) : null}
          <div className="actions">
            <button className="primary" type="submit" disabled={busy}>Save account</button>
            <button type="button" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      ) : null}
      <div className="table-wrap card">
        <table>
          <thead><tr><th>Store</th><th>Label</th><th>Username</th><th>Password</th><th>Session</th><th></th></tr></thead>
          <tbody>
            {accounts.length === 0 ? <tr><td colSpan={6} className="empty">No accounts yet.</td></tr> : accounts.map((account) => (
              <tr key={account.id}>
                <td>{storeName.get(account.store) ?? account.store}</td>
                <td>{account.label}</td>
                <td>{account.username}</td>
                <td>{account.hasPassword ? "Saved" : "None"}</td>
                <td>{account.hasSession ? "Saved" : "None"}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => setForm({ id: account.id, store: account.store, label: account.label, username: account.username, password: "", session: "", clearSession: false })}>Edit</button>
                  <button type="button" className="danger" onClick={() => void remove(account.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
