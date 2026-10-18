import { useEffect, useState } from "react"
import { clientText, ME_CLIENT_ID, type Client, type ClientInput, type ClientSummary, type LedgerEntry } from "../../../shared/clients"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

function blankForm(): ClientInput {
  return { name: "", contact: "", notes: "", fee: 0, feeBasis: "success", status: "active", webhook: "" }
}

function fromClient(client: Client): ClientInput {
  return {
    id: client.id,
    name: client.name,
    contact: client.contact,
    notes: client.notes,
    fee: client.fee,
    feeBasis: client.feeBasis,
    status: client.status,
    webhook: client.webhook
  }
}

export function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [summaries, setSummaries] = useState<ClientSummary[]>([])
  const [ledger, setLedger] = useState<LedgerEntry[]>([])
  const [selectedId, setSelectedId] = useState(ME_CLIENT_ID)
  const [form, setForm] = useState<ClientInput | null>(null)
  const [lang, setLang] = useState<"en" | "es">("en")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const text = (key: Parameters<typeof clientText>[1]) => clientText(lang, key)
  const selected = clients.find((client) => client.id === selectedId) ?? clients[0]
  const summary = summaries.find((row) => row.clientId === selected?.id)

  async function reload(nextId = selectedId) {
    const [nextClients, nextSummaries, settings] = await Promise.all([
      unwrap(window.aio.clients.list()),
      unwrap(window.aio.clients.summaries()),
      unwrap(window.aio.settings.get())
    ])
    setClients(nextClients)
    setSummaries(nextSummaries)
    setLang(settings.settings.language === "es" ? "es" : "en")
    const id = nextClients.some((client) => client.id === nextId) ? nextId : nextClients[0]?.id ?? ME_CLIENT_ID
    setSelectedId(id)
    setLedger(await unwrap(window.aio.clients.ledger(id)))
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
  }, [])

  async function choose(id: string) {
    setSelectedId(id)
    setError("")
    try {
      setLedger(await unwrap(window.aio.clients.ledger(id)))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!form) return
    setBusy(true)
    setError("")
    try {
      const saved = await unwrap(window.aio.clients.save(form))
      setForm(null)
      await reload(saved.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function mark(ids: string[], paid: boolean) {
    if (!selected) return
    setError("")
    try {
      setLedger(await unwrap(window.aio.clients.markPaid(selected.id, ids, paid)))
      setSummaries(await unwrap(window.aio.clients.summaries()))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function downloadCsv() {
    if (!selected) return
    const file = await unwrap(window.aio.clients.csv(selected.id))
    download(file.csv, `${slug(selected.name)}-ledger.csv`, "text/csv")
  }

  async function exportData() {
    if (!selected) return
    const data = await unwrap(window.aio.clients.exportData(selected.id))
    download(JSON.stringify(data, null, 2), `${slug(selected.name)}.json`, "application/json")
  }

  async function remove() {
    if (!selected || selected.id === ME_CLIENT_ID) return
    if (!window.confirm(text("deleteConfirm"))) return
    setError("")
    try {
      await unwrap(window.aio.clients.delete(selected.id))
      setForm(null)
      await reload(ME_CLIENT_ID)
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>{text("title")}</h1>
          <p>{text("intro")}</p>
        </div>
        <button type="button" className="primary" onClick={() => { setForm(blankForm()); setError("") }}>{text("new")}</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {form ? (
        <form className="card form-grid" onSubmit={save}>
          <Field label={text("name")}><TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></Field>
          <Field label={text("contact")}><TextInput value={form.contact ?? ""} onChange={(event) => setForm({ ...form, contact: event.target.value })} /></Field>
          <Field className="span-2" label={text("notes")}>
            <textarea value={form.notes ?? ""} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={3} />
          </Field>
          <Field label={text("fee")}>
            <TextInput type="number" min={0} max={10000} step="0.01" value={form.fee ?? 0} onChange={(event) => setForm({ ...form, fee: Number(event.target.value) })} required />
          </Field>
          <Field label={text("basis")}>
            <Select value={form.feeBasis ?? "success"} onChange={(event) => setForm({ ...form, feeBasis: event.target.value === "item" ? "item" : "success" })}>
              <option value="success">{text("perSuccess")}</option>
              <option value="item">{text("perItem")}</option>
            </Select>
          </Field>
          <Field label={text("status")}>
            <Select value={form.status ?? "active"} onChange={(event) => setForm({ ...form, status: event.target.value === "paused" ? "paused" : "active" })}>
              <option value="active">{text("active")}</option>
              <option value="paused">{text("paused")}</option>
            </Select>
          </Field>
          <Field className="span-2" label={text("webhook")} hint={text("webhookHint")}>
            <TextInput value={form.webhook ?? ""} onChange={(event) => setForm({ ...form, webhook: event.target.value })} placeholder="https://discord.com/api/webhooks/" inputMode="url" />
          </Field>
          <div className="actions span-2">
            <button className="primary" type="submit" disabled={busy}>{text("save")}</button>
            <button type="button" onClick={() => setForm(null)}>{text("cancel")}</button>
          </div>
        </form>
      ) : null}
      <div className="table-wrap card">
        <table>
          <thead>
            <tr>
              <th>{text("name")}</th>
              <th>{text("status")}</th>
              <th>{text("fee")}</th>
              <th>{text("successes")}</th>
              <th>{text("owed")}</th>
              <th>{text("paid")}</th>
              <th>{text("open")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {clients.length === 0 ? <tr><td colSpan={8} className="empty">{text("empty")}</td></tr> : clients.map((client) => {
              const row = summaries.find((item) => item.clientId === client.id)
              return (
                <tr key={client.id} className={client.id === selected?.id ? "selected" : ""} onClick={() => void choose(client.id)}>
                  <td>{client.name}{client.contact ? <div className="detail">{client.contact}</div> : null}</td>
                  <td>{client.status === "paused" ? text("paused") : text("active")}</td>
                  <td>${client.fee.toFixed(2)} · {client.feeBasis === "item" ? text("perItem") : text("perSuccess")}</td>
                  <td>{row?.successes ?? 0}</td>
                  <td>${(row?.feesOwed ?? 0).toFixed(2)}</td>
                  <td>${(row?.feesPaid ?? 0).toFixed(2)}</td>
                  <td>${(row?.feesOpen ?? 0).toFixed(2)}</td>
                  <td className="row-actions">
                    <button type="button" onClick={(event) => { event.stopPropagation(); setForm(fromClient(client)); setError("") }}>{text("edit")}</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {selected ? (
        <div className="card stack">
          <header className="page-head">
            <div>
              <h2>{selected.name} · {text("ledger")}</h2>
              <p className="hint">{text("exportHint")}</p>
              {summary ? <p className="hint">{text("successes")} {summary.successes} · {text("open")} ${summary.feesOpen.toFixed(2)}</p> : null}
            </div>
            <div className="actions">
              <button type="button" onClick={() => void mark([], true)}>{text("markPaid")}</button>
              <button type="button" onClick={() => void downloadCsv().catch((err) => setError(errorText(err)))}>{text("csv")}</button>
              <button type="button" onClick={() => void exportData().catch((err) => setError(errorText(err)))}>{text("exportData")}</button>
              {selected.id === ME_CLIENT_ID ? null : <button type="button" className="danger" onClick={() => void remove()}>{text("deleteData")}</button>}
            </div>
          </header>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{text("when")}</th>
                  <th>{text("product")}</th>
                  <th>{text("qty")}</th>
                  <th>{text("price")}</th>
                  <th>{text("order")}</th>
                  <th>{text("fee")}</th>
                  <th>{text("paid")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {ledger.length === 0 ? <tr><td colSpan={8} className="empty">{text("noRows")}</td></tr> : ledger.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.at).toLocaleString()}</td>
                    <td className="sku">{row.store} · {row.product}</td>
                    <td>{row.quantity}</td>
                    <td>{row.price === null ? "—" : `$${row.price.toFixed(2)}`}</td>
                    <td>{row.orderId || "—"}</td>
                    <td>${row.fee.toFixed(2)}</td>
                    <td>{row.paid ? text("paid") : text("open")}</td>
                    <td className="row-actions">
                      <button type="button" onClick={() => void mark([row.id], !row.paid)}>{row.paid ? text("markUnpaid") : text("markOne")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function slug(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return clean || "client"
}

function download(body: string, filename: string, type: string) {
  const blob = new Blob([body], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
