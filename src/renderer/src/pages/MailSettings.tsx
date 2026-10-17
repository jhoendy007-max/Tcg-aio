import { useEffect, useState } from "react"
import { MAIL_PRESETS, presetGuidance, type MailProvider } from "../../../shared/mail"
import type { MailboxInput, MailboxView } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

const empty = (provider: MailProvider = "gmail"): MailboxInput => {
  const preset = provider === "custom" ? null : MAIL_PRESETS[provider]
  return {
    name: "",
    enabled: true,
    provider,
    host: preset?.host ?? "",
    port: preset?.port ?? 993,
    secure: preset?.secure ?? true,
    user: "",
    mailbox: "INBOX",
    password: "",
    passwordAction: "keep",
    orders: true,
    alerts: false,
    codes: true
  }
}

function fromView(view: MailboxView): MailboxInput {
  return {
    id: view.id,
    name: view.name,
    enabled: view.enabled,
    provider: view.provider,
    host: view.host,
    port: view.port,
    secure: view.secure,
    user: view.user,
    mailbox: view.mailbox,
    password: "",
    passwordAction: "keep",
    orders: view.orders,
    alerts: view.alerts,
    codes: view.codes
  }
}

export function MailSettings() {
  const [rows, setRows] = useState<MailboxView[]>([])
  const [form, setForm] = useState<MailboxInput | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  async function load() {
    const next = await unwrap(window.aio.mail.list())
    setRows(next)
  }

  useEffect(() => {
    void load().catch((err) => setError(errorText(err)))
  }, [])

  function applyProvider(provider: MailProvider) {
    const preset = provider === "custom" ? null : MAIL_PRESETS[provider]
    setForm((current) => current ? {
      ...current,
      provider,
      host: preset?.host ?? current.host,
      port: preset?.port ?? current.port,
      secure: preset ? preset.secure : current.secure
    } : current)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!form) return
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const saved = await unwrap(window.aio.mail.save({
        ...form,
        passwordAction: form.password ? "replace" : "keep"
      }))
      setForm(fromView(saved))
      setFolders(saved.folders)
      setMessage("Mailbox saved. The app password stays on this PC.")
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function testConnection() {
    if (!form) return
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const saved = await unwrap(window.aio.mail.save({
        ...form,
        passwordAction: form.password ? "replace" : "keep"
      }))
      const tested = await unwrap(window.aio.mail.test(saved.id))
      setForm(fromView(tested))
      setFolders(tested.folders.length ? tested.folders : ["INBOX"])
      setMessage(tested.folders.length ? `Connected. ${tested.folders.length} folders.` : "Connected.")
      await load()
    } catch (err) {
      setError(errorText(err))
      await load().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    setError("")
    try {
      await unwrap(window.aio.mail.delete(id))
      if (form?.id === id) setForm(null)
      setMessage("Mailbox removed.")
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const folderNames = folders.length ? folders : form?.mailbox ? [form.mailbox] : ["INBOX"]

  return (
    <section className="card stack">
      <div>
        <h2>Mail</h2>
        <p className="hint">Read-only IMAP for your own store mail. TCGAIO can read a sign-in code, order and shipping mail, and optional restock or newsletter alerts. It never sends mail. App passwords are encrypted on this PC. Messages count only when the sender is that store.</p>
      </div>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      {rows.length ? rows.map((row) => (
        <div key={row.id} className="row">
          <span>{row.enabled ? "On" : "Off"} · {row.name} · {row.user} · {row.mailbox}{row.lastError ? ` · ${row.lastError}` : ""}</span>
          <button type="button" onClick={() => { setForm(fromView(row)); setFolders(row.folders); setError(""); setMessage("") }}>Edit</button>
          <button type="button" onClick={() => void remove(row.id)} disabled={busy}>Remove</button>
        </div>
      )) : <p>No mailboxes yet.</p>}
      {!form ? <div className="actions"><button type="button" className="primary" onClick={() => { setForm(empty()); setFolders(["INBOX"]); setError(""); setMessage("") }}>Add mailbox</button></div> : null}
      {form ? (
        <form className="form-grid" onSubmit={save}>
          <Field label="Provider">
            <Select value={form.provider} onChange={(event) => applyProvider(event.target.value as MailProvider)}>
              <option value="gmail">Gmail</option>
              <option value="outlook">Outlook</option>
              <option value="icloud">iCloud</option>
              <option value="yahoo">Yahoo</option>
              <option value="custom">Custom</option>
            </Select>
          </Field>
          <Field label="Name">
            <TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Personal Gmail" />
          </Field>
          <p className="hint span-2">{presetGuidance(form.provider)}</p>
          <Field label="Host">
            <TextInput value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value, provider: "custom" })} placeholder="imap.example.com" required />
          </Field>
          <Field label="Port">
            <TextInput type="number" min={1} max={65535} value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} required />
          </Field>
          <label className="check span-2">
            <input type="checkbox" checked={form.secure} onChange={(event) => setForm({ ...form, secure: event.target.checked })} />
            <span>SSL/TLS. On connects with implicit TLS. Off uses STARTTLS and will not send the password if the server does not upgrade.</span>
          </label>
          <Field label="Username">
            <TextInput value={form.user} onChange={(event) => setForm({ ...form, user: event.target.value })} autoComplete="off" required />
          </Field>
          <Field label="App password" hint={form.id ? "Leave blank to keep the saved app password." : "An app password, not the account password when the provider offers one."}>
            <TextInput type="password" autoComplete="off" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </Field>
          <Field label="Folder" hint="Test the connection to load the folder list.">
            <Select value={form.mailbox} onChange={(event) => setForm({ ...form, mailbox: event.target.value })}>
              {folderNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </Select>
          </Field>
          <Field label="Folder name" hint="Use this if the folder is not in the list.">
            <TextInput value={form.mailbox} onChange={(event) => setForm({ ...form, mailbox: event.target.value })} />
          </Field>
          <label className="check span-2">
            <input type="checkbox" checked={form.codes} onChange={(event) => setForm({ ...form, codes: event.target.checked })} />
            <span>Sign-in codes. Fill a verification code from this mailbox into your own store sign-in.</span>
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.orders} onChange={(event) => setForm({ ...form, orders: event.target.checked })} />
            <span>Order mail. Read confirmation, shipping, and cancellation messages for order tracking.</span>
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.alerts} onChange={(event) => setForm({ ...form, alerts: event.target.checked })} />
            <span>Restock and newsletter alerts. Optional. A match notifies you. It does not start checkout.</span>
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
            <span>Use this mailbox.</span>
          </label>
          <div className="actions span-2">
            <button className="primary" type="submit" disabled={busy}>Save mailbox</button>
            <button type="button" onClick={() => void testConnection()} disabled={busy}>Test connection</button>
            <button type="button" onClick={() => setForm(null)} disabled={busy}>Close</button>
          </div>
        </form>
      ) : null}
    </section>
  )
}
