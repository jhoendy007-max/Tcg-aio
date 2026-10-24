import { useEffect, useState } from "react"
import { ME_CLIENT_ID, type Client } from "../../../shared/clients"
import { consistencyText } from "../../../shared/consistency"
import type { AccountInput, ProxyGroup, PublicAccount, StoreId, StoreInfo } from "../../../shared/types"
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
  proxyGroupId: string
  clientId: string
}

const blank = (): FormState => ({
  store: "target",
  label: "",
  username: "",
  password: "",
  session: "",
  clearSession: false,
  proxyGroupId: "",
  clientId: ME_CLIENT_ID
})

export function AccountsPage() {
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [stores, setStores] = useState<StoreInfo[]>([])
  const [groups, setGroups] = useState<ProxyGroup[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [form, setForm] = useState<FormState | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [lang, setLang] = useState<"en" | "es">("en")

  async function reload() {
    const [nextAccounts, nextStores, nextGroups, nextClients, settings] = await Promise.all([
      unwrap(window.aio.accounts.list()),
      unwrap(window.aio.stores.list()),
      unwrap(window.aio.proxies.list()),
      unwrap(window.aio.clients.list()),
      unwrap(window.aio.settings.get())
    ])
    setAccounts(nextAccounts)
    setStores(nextStores)
    setGroups(nextGroups)
    setClients(nextClients)
    setLang(settings.settings.language === "es" ? "es" : "en")
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
        sessionAction: form.clearSession ? "clear" : form.session.trim() ? "replace" : form.id ? "keep" : "clear",
        proxyGroupId: form.proxyGroupId || null,
        clientId: form.clientId || ME_CLIENT_ID
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
          <p>{consistencyText(lang, "accountsIntro")}</p>
        </div>
        <button type="button" className="primary" onClick={() => { setForm(blank()); setError("") }}>New account</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {form ? (
        <div className="drawer-scrim" onMouseDown={() => setForm(null)}>
        <form className="drawer stack" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
          <div className="form-grid">
            <Field label="Store">
              <Select value={form.store} onChange={(event) => setForm({ ...form, store: event.target.value as StoreId })}>
                {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
              </Select>
            </Field>
            <Field label="Label"><TextInput value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} required /></Field>
            <Field label="Username"><TextInput type="email" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required /></Field>
            <Field label="Client" hint="Each client keeps a separate browser session. A proxy group cannot be shared with another client.">
              <Select value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })}>
                {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
              </Select>
            </Field>
            <Field label="Proxy group" hint={consistencyText(lang, "stickyHint")}>
              <Select value={form.proxyGroupId} onChange={(event) => setForm({ ...form, proxyGroupId: event.target.value })}>
                <option value="">No assigned proxy</option>
                {groups.map((group) => <option key={group.id} value={group.id}>{group.name} · {group.network}</option>)}
              </Select>
            </Field>
            <Field label="Password" hint={form.id ? "Leave blank to keep the saved password." : "Optional. You can sign in with the browser instead."}>
              <TextInput type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
            </Field>
          </div>
          <Field label="Browser session" hint="Target: accessToken, visitorId, and refreshToken. Walmart: auth and CID. Best Buy: the www.bestbuy.com cookie header, including at. Pokémon Center: the full www.pokemoncenter.com cookie header. Crunchyroll: the www.crunchyroll.com cookie header or the shopper access token. Premium Bandai: the p-bandai.com cookie header. Amazon: the www.amazon.com cookie header, including at-main. GameStop, Barnes & Noble, Costco, and Sam's Club: that store's cookie header. TCGplayer catalog reads work without a session. TCGplayer checkout needs the www.tcgplayer.com cookie header. Cookie strings or the same fields as JSON. Leave blank to keep a saved session.">
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
        </div>
      ) : null}
      <div className="table-wrap card manager">
        <table>
          <thead><tr><th>Store</th><th>Client</th><th>Label</th><th>Username</th><th>Password</th><th>{consistencyText(lang, "freshness")}</th><th>{consistencyText(lang, "profile")}</th><th>{consistencyText(lang, "stickyProxy")}</th><th>{lang === "es" ? "Proxy del navegador" : "Browser proxy"}</th><th></th></tr></thead>
          <tbody>
            {accounts.length === 0 ? <tr><td colSpan={10} className="empty">No accounts yet.</td></tr> : accounts.map((account) => (
              <tr key={account.id}>
                <td>{storeName.get(account.store) ?? account.store}</td>
                <td>{clients.find((client) => client.id === (account.clientId || ME_CLIENT_ID))?.name ?? "Me"}</td>
                <td>{account.label}</td>
                <td>{account.username}</td>
                <td>{account.hasPassword ? "Saved" : "None"}</td>
                <td>{consistencyText(lang, account.freshness ?? "missing")}{account.lastWarmAt ? <div className="detail">{new Date(account.lastWarmAt).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}</div> : null}</td>
                <td>{account.profilePartition ?? ""}</td>
                <td>{account.stickyProxyLabel || "—"}</td>
                <td className="browser-proxy" data-status={account.browserProxy?.status ?? "direct"}>
                  {account.browserProxy ? (
                    <>
                      <span className={`pill bp-${account.browserProxy.status}`}>{bindingText(lang, account.browserProxy.status)}</span>
                      <div className="detail">{account.browserProxy.label ?? account.browserProxy.groupName ?? ""}</div>
                      {account.browserProxy.status === "direct-warning" || account.browserProxy.status === "conflict" ? <div className="detail bp-warn">{account.browserProxy.note}</div> : null}
                    </>
                  ) : "—"}
                </td>
                <td className="row-actions">
                  <button type="button" onClick={() => void unwrap(window.aio.accounts.openBrowser(account.id)).catch((err) => setError(errorText(err)))}>Sign in</button>
                  <button type="button" title="Target rejected the window? Sign in with your own browser, then use Session-Sync or Save cookies." onClick={() => void unwrap(window.aio.accounts.openInMyBrowser(account.id)).catch((err) => setError(errorText(err)))}>Open in my browser</button>
                  <button type="button" onClick={() => void unwrap(window.aio.accounts.captureBrowser(account.id)).then(() => reload()).catch((err) => setError(errorText(err)))}>Save cookies</button>
                  <button type="button" onClick={() => setForm({ id: account.id, store: account.store, label: account.label, username: account.username, password: "", session: "", clearSession: false, proxyGroupId: account.proxyGroupId ?? "", clientId: account.clientId || ME_CLIENT_ID })}>Edit</button>
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

function bindingText(lang: string, status: string): string {
  const es: Record<string, string> = { bound: "Atado al proxy", pending: "Se ata al primer uso", direct: "Directo", "direct-warning": "Saldría directo", conflict: "Conflicto de proxy" }
  const en: Record<string, string> = { bound: "Bound to proxy", pending: "Binds on first use", direct: "Direct (no proxy)", "direct-warning": "Would run direct", conflict: "Proxy conflict" }
  return (lang === "es" ? es : en)[status] ?? status
}
