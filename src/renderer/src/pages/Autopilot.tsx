import { useEffect, useState } from "react"
import { STORE_CATALOG } from "../../../shared/stores"
import type { ImapView, OrderRecord, PublicAccount, PublicProfile, TaskTemplate, TaskTemplateInput } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

const empty = (profiles: PublicProfile[], accounts: PublicAccount[]): TaskTemplateInput => ({
  name: "",
  enabled: true,
  store: "",
  sku: "",
  keywords: "",
  profileIds: profiles[0] ? [profiles[0].id] : [],
  accountIds: accounts[0] ? [accounts[0].id] : [],
  proxyGroupId: null,
  quantity: 1,
  maxPrice: null,
  testMode: true,
  confirmPurchase: false,
  group: ""
})

export function AutopilotPage() {
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  const [orders, setOrders] = useState<OrderRecord[]>([])
  const [profiles, setProfiles] = useState<PublicProfile[]>([])
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [form, setForm] = useState<TaskTemplateInput>(empty([], []))
  const [imap, setImap] = useState<ImapView>({ enabled: false, host: "", port: 993, user: "", mailbox: "INBOX", hasPassword: false })
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")

  async function load() {
    const [nextTemplates, nextOrders, nextProfiles, nextAccounts, nextImap] = await Promise.all([
      unwrap(window.aio.autopilot.list()),
      unwrap(window.aio.autopilot.orders()),
      unwrap(window.aio.profiles.list()),
      unwrap(window.aio.accounts.list()),
      unwrap(window.aio.autopilot.imap())
    ])
    setTemplates(nextTemplates)
    setOrders(nextOrders)
    setProfiles(nextProfiles)
    setAccounts(nextAccounts)
    setImap(nextImap)
    setForm((current) => current.name ? current : empty(nextProfiles, nextAccounts))
  }

  useEffect(() => {
    void load().catch((err) => setError(errorText(err)))
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError("")
    try {
      await unwrap(window.aio.autopilot.save(form))
      setMessage("Template saved.")
      setForm(empty(profiles, accounts))
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function saveMail(event: React.FormEvent) {
    event.preventDefault()
    setError("")
    try {
      const next = await unwrap(window.aio.autopilot.saveImap({
        ...imap,
        password,
        passwordAction: password ? "replace" : "keep"
      }))
      setImap(next)
      setPassword("")
      setMessage("Mail tracking saved. The password stays on this PC.")
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Autopilot</h1>
          <p>Templates start only while Autopilot is on in Settings. A price cap skips a signal that has no price. Rotation uses your own accounts and cards, and stops at the purchase limits.</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      <form className="card form-grid" onSubmit={save}>
        <Field label="Name"><TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></Field>
        <Field label="Store">
          <Select value={form.store} onChange={(event) => setForm({ ...form, store: event.target.value as TaskTemplateInput["store"] })}>
            <option value="">Any store</option>
            {STORE_CATALOG.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
          </Select>
        </Field>
        <Field label="SKU" hint="Blank matches by keywords."><TextInput value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} /></Field>
        <Field label="Keywords"><TextInput value={form.keywords} onChange={(event) => setForm({ ...form, keywords: event.target.value })} /></Field>
        <Field label="Quantity"><TextInput type="number" min={1} max={12} value={form.quantity} onChange={(event) => setForm({ ...form, quantity: Number(event.target.value) })} /></Field>
        <Field label="Price cap" hint="Blank means no template cap.">
          <TextInput value={form.maxPrice ?? ""} onChange={(event) => setForm({ ...form, maxPrice: event.target.value === "" ? null : Number(event.target.value) })} />
        </Field>
        <Field label="Profiles" hint="Autopilot rotates across these cards.">
          <Select multiple value={form.profileIds} onChange={(event) => setForm({ ...form, profileIds: [...event.target.selectedOptions].map((option) => option.value) })}>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.last4}</option>)}
          </Select>
        </Field>
        <Field label="Accounts" hint="Only accounts you already saved.">
          <Select multiple value={form.accountIds} onChange={(event) => setForm({ ...form, accountIds: [...event.target.selectedOptions].map((option) => option.value) })}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.store}</option>)}
          </Select>
        </Field>
        <label className="check span-2">
          <input type="checkbox" checked={form.testMode} onChange={(event) => setForm({ ...form, testMode: event.target.checked })} />
          <span>Start in test mode. Place order is not sent.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.confirmPurchase} onChange={(event) => setForm({ ...form, confirmPurchase: event.target.checked })} />
          <span>This template may place a real order when test mode is off.</span>
        </label>
        <div className="actions span-2"><button className="primary" type="submit">Save template</button></div>
      </form>
      <div className="card stack">
        <h2>Templates</h2>
        {templates.length ? templates.map((template) => (
          <div key={template.id} className="row">
            <span>{template.enabled ? "On" : "Off"} · {template.name} · {template.store || "any"} · {template.sku || template.keywords} · cap {template.maxPrice ?? "none"}</span>
            <button type="button" onClick={() => void unwrap(window.aio.autopilot.delete(template.id)).then(load).catch((err) => setError(errorText(err)))}>Delete</button>
          </div>
        )) : <p>No templates yet.</p>}
      </div>
      <div className="card stack">
        <h2>Orders</h2>
        {orders.length ? orders.map((order) => (
          <p key={order.id}>{order.store} · {order.sku} · {order.orderId} · {order.status}{order.tracking ? ` · ${order.tracking}` : ""}</p>
        )) : <p>Order numbers show up here after a win. Status checks use your saved session, and mail only if you connect a mailbox below.</p>}
      </div>
      <form className="card form-grid" onSubmit={saveMail}>
        <div className="span-2">
          <h2>Order mail</h2>
          <p className="hint">Optional. TCGAIO signs in to your mailbox over TLS and reads recent messages for order and tracking text. The password is encrypted on this PC.</p>
        </div>
        <label className="check span-2">
          <input type="checkbox" checked={imap.enabled} onChange={(event) => setImap({ ...imap, enabled: event.target.checked })} />
          <span>Check this mailbox for cancellations and tracking numbers.</span>
        </label>
        <Field label="Host"><TextInput value={imap.host} onChange={(event) => setImap({ ...imap, host: event.target.value })} placeholder="imap.example.com" /></Field>
        <Field label="Port"><TextInput type="number" value={imap.port} onChange={(event) => setImap({ ...imap, port: Number(event.target.value) })} /></Field>
        <Field label="Username"><TextInput value={imap.user} onChange={(event) => setImap({ ...imap, user: event.target.value })} /></Field>
        <Field label="Mailbox"><TextInput value={imap.mailbox} onChange={(event) => setImap({ ...imap, mailbox: event.target.value })} /></Field>
        <Field className="span-2" label="Password" hint={imap.hasPassword ? "A password is saved. Paste a new one to replace it." : "No password saved yet."}>
          <TextInput type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <div className="actions span-2"><button className="primary" type="submit">Save mail</button></div>
      </form>
    </section>
  )
}
