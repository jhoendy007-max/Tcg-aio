import { useEffect, useState } from "react"
import { STORE_CATALOG } from "../../../shared/stores"
import type { OrderRecord, PublicAccount, PublicProfile, TaskTemplate, TaskTemplateInput } from "../../../shared/types"
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
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")

  async function load() {
    const [nextTemplates, nextOrders, nextProfiles, nextAccounts] = await Promise.all([
      unwrap(window.aio.autopilot.list()),
      unwrap(window.aio.autopilot.orders()),
      unwrap(window.aio.profiles.list()),
      unwrap(window.aio.accounts.list())
    ])
    setTemplates(nextTemplates)
    setOrders(nextOrders)
    setProfiles(nextProfiles)
    setAccounts(nextAccounts)
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
        )) : <p>Order numbers show up here after a win. Status checks use your saved session. Order mail is read from the mailboxes in Settings.</p>}
      </div>
    </section>
  )
}
