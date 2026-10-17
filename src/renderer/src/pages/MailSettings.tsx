import { useEffect, useState } from "react"
import { detectMailbox, type MailLang, type MailProvider } from "../../../shared/mail"
import { mailGuide, mailText, type MailTextKey } from "../../../shared/mail-text"
import type { MailboxInput, MailboxView, Settings } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

const empty = (): MailboxInput => ({
  name: "",
  enabled: true,
  provider: "gmail",
  host: "",
  port: 993,
  secure: true,
  user: "",
  mailbox: "INBOX",
  password: "",
  passwordAction: "keep",
  orders: true,
  alerts: false,
  codes: true
})

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
  const [signedIn, setSignedIn] = useState(false)
  const [guessed, setGuessed] = useState(false)
  const [folders, setFolders] = useState<string[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [googleId, setGoogleId] = useState("")
  const [microsoftId, setMicrosoftId] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  const lang: MailLang = settings?.language === "es" ? "es" : "en"
  const t = (key: MailTextKey) => mailText(lang, key)

  async function load() {
    const [next, payload] = await Promise.all([
      unwrap(window.aio.mail.list()),
      unwrap(window.aio.settings.get())
    ])
    setRows(next)
    setSettings(payload.settings)
    setGoogleId(payload.settings.googleMailClientId)
    setMicrosoftId(payload.settings.microsoftMailClientId)
  }

  useEffect(() => {
    void load().catch((err) => setError(errorText(err)))
  }, [])

  function applyEmail(value: string) {
    const found = detectMailbox(value)
    setGuessed(Boolean(found?.guessed))
    setForm((current) => {
      if (!current) return current
      if (!found) return { ...current, user: value }
      return {
        ...current,
        user: found.user,
        provider: found.provider,
        host: found.host,
        port: found.port,
        secure: found.secure,
        name: current.name || found.user
      }
    })
  }

  function applyProvider(provider: MailProvider) {
    const found = provider === "custom" ? null : detectMailbox(`person@${provider === "gmail" ? "gmail.com" : provider === "outlook" ? "outlook.com" : provider === "icloud" ? "icloud.com" : "yahoo.com"}`)
    setGuessed(false)
    setForm((current) => current ? {
      ...current,
      provider,
      host: found?.host ?? current.host,
      port: found?.port ?? current.port,
      secure: found ? found.secure : current.secure
    } : current)
  }

  async function saveLanguage(next: MailLang) {
    if (!settings) return
    const saved = await unwrap(window.aio.settings.save({ ...settings, language: next }))
    setSettings(saved.settings)
  }

  async function saveClients() {
    if (!settings) return
    setBusy(true)
    setError("")
    try {
      const saved = await unwrap(window.aio.settings.save({ ...settings, googleMailClientId: googleId, microsoftMailClientId: microsoftId }))
      setSettings(saved.settings)
      setMessage(t("clientsSaved"))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
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
      setSignedIn(saved.auth === "xoauth2")
      setFolders(saved.folders)
      setMessage(t("saved"))
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
      setSignedIn(tested.auth === "xoauth2")
      setFolders(tested.folders.length ? tested.folders : ["INBOX"])
      setMessage(tested.folders.length ? t("connectedFolders") : t("connected"))
      await load()
    } catch (err) {
      setError(errorText(err))
      await load().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  async function signIn(provider: "gmail" | "outlook") {
    if (!form) return
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const saved = await unwrap(window.aio.mail.signIn({ provider, user: form.user }))
      setForm(fromView(saved))
      setSignedIn(true)
      setFolders(saved.folders)
      setMessage(t("signedIn"))
      await load()
    } catch (err) {
      setError(errorText(err))
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
      setMessage(t("removed"))
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function openLink(href: string) {
    setError("")
    try {
      await unwrap(window.aio.mail.open(href))
    } catch (err) {
      setError(errorText(err))
    }
  }

  const folderNames = folders.length ? folders : form?.mailbox ? [form.mailbox] : ["INBOX"]
  const guide = form ? mailGuide(form.provider, lang) : null

  return (
    <section className="card stack">
      <div>
        <h2>{t("title")}</h2>
        <p className="hint">{t("intro")}</p>
      </div>
      <Field label={t("language")}>
        <Select value={lang} onChange={(event) => void saveLanguage(event.target.value === "es" ? "es" : "en")}>
          <option value="en">English</option>
          <option value="es">Español</option>
        </Select>
      </Field>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      {rows.length ? rows.map((row) => (
        <div key={row.id} className="row">
          <span>{row.enabled ? t("on") : t("off")} · {row.name} · {row.user} · {row.auth === "xoauth2" ? t("oauth") : t("password")} · {row.mailbox}{row.lastError ? ` · ${row.lastError}` : ""}</span>
          <button type="button" onClick={() => { setForm(fromView(row)); setSignedIn(row.auth === "xoauth2"); setFolders(row.folders); setGuessed(false); setError(""); setMessage("") }}>{t("edit")}</button>
          <button type="button" onClick={() => void remove(row.id)} disabled={busy}>{t("remove")}</button>
        </div>
      )) : <p>{t("none")}</p>}
      {!form ? <div className="actions"><button type="button" className="primary" onClick={() => { setForm(empty()); setSignedIn(false); setFolders(["INBOX"]); setGuessed(false); setError(""); setMessage("") }}>{t("add")}</button></div> : null}
      {form ? (
        <form className="form-grid" onSubmit={save}>
          <Field className="span-2" label={t("email")} hint={t("emailHint")}>
            <TextInput value={form.user} onChange={(event) => applyEmail(event.target.value)} autoComplete="off" placeholder="ada@gmail.com" required />
          </Field>
          {guessed ? <p className="hint span-2">{t("guessed")}</p> : null}
          <Field label={t("provider")}>
            <Select value={form.provider} onChange={(event) => applyProvider(event.target.value as MailProvider)}>
              <option value="gmail">Gmail</option>
              <option value="outlook">Outlook</option>
              <option value="icloud">iCloud</option>
              <option value="yahoo">Yahoo</option>
              <option value="custom">{lang === "es" ? "Otro" : "Custom"}</option>
            </Select>
          </Field>
          <Field label={t("name")}>
            <TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={form.user || "Ada"} />
          </Field>
          {form.provider === "gmail" || form.provider === "outlook" ? (
            <div className="actions span-2">
              {form.provider === "gmail" ? <button type="button" className="primary" disabled={busy} onClick={() => void signIn("gmail")}>{t("signInGoogle")}</button> : null}
              {form.provider === "outlook" ? <button type="button" className="primary" disabled={busy} onClick={() => void signIn("outlook")}>{t("signInMicrosoft")}</button> : null}
              {signedIn ? <span>{t("signedIn")}</span> : null}
            </div>
          ) : null}
          {guide && guide.steps.length ? (
            <div className="span-2">
              <h3>{t("steps")}</h3>
              <ol>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
              <div className="actions">
                {guide.links.map((link) => (
                  <button key={link.href} type="button" onClick={() => void openLink(link.href)}>{link.label}</button>
                ))}
              </div>
            </div>
          ) : null}
          <Field label={t("host")}>
            <TextInput value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} placeholder="imap.example.com" required />
          </Field>
          <Field label={t("port")}>
            <TextInput type="number" min={1} max={65535} value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} required />
          </Field>
          <label className="check span-2">
            <input type="checkbox" checked={form.secure} onChange={(event) => setForm({ ...form, secure: event.target.checked })} />
            <span>{t("ssl")}</span>
          </label>
          <Field className="span-2" label={t("appPassword")} hint={t("appPasswordHint")}>
            <TextInput type="password" autoComplete="off" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </Field>
          <Field label={t("folder")} hint={t("folderHint")}>
            <Select value={form.mailbox} onChange={(event) => setForm({ ...form, mailbox: event.target.value })}>
              {folderNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </Select>
          </Field>
          <Field label={t("folderName")}>
            <TextInput value={form.mailbox} onChange={(event) => setForm({ ...form, mailbox: event.target.value })} />
          </Field>
          <label className="check span-2">
            <input type="checkbox" checked={form.codes} onChange={(event) => setForm({ ...form, codes: event.target.checked })} />
            <span>{t("codes")}</span>
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.orders} onChange={(event) => setForm({ ...form, orders: event.target.checked })} />
            <span>{t("orders")}</span>
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.alerts} onChange={(event) => setForm({ ...form, alerts: event.target.checked })} />
            <span>{t("alerts")}</span>
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
            <span>{t("enabled")}</span>
          </label>
          <div className="actions span-2">
            <button className="primary" type="submit" disabled={busy}>{t("save")}</button>
            <button type="button" onClick={() => void testConnection()} disabled={busy}>{t("test")}</button>
            <button type="button" onClick={() => setForm(null)} disabled={busy}>{t("close")}</button>
          </div>
        </form>
      ) : null}
      <div className="form-grid">
        <p className="hint span-2">{t("clientHint")}</p>
        <Field label={t("clientGoogle")}>
          <TextInput value={googleId} onChange={(event) => setGoogleId(event.target.value)} autoComplete="off" placeholder="….apps.googleusercontent.com" />
        </Field>
        <Field label={t("clientMicrosoft")}>
          <TextInput value={microsoftId} onChange={(event) => setMicrosoftId(event.target.value)} autoComplete="off" />
        </Field>
        <div className="actions span-2">
          <button type="button" onClick={() => void saveClients()} disabled={busy}>{t("saveClients")}</button>
          <button type="button" onClick={() => void openLink("https://console.cloud.google.com/apis/credentials")}>{lang === "es" ? "Consola de Google" : "Google console"}</button>
          <button type="button" onClick={() => void openLink("https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade")}>{lang === "es" ? "Portal de Microsoft" : "Microsoft portal"}</button>
        </div>
      </div>
    </section>
  )
}
