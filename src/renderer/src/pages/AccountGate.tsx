import { useEffect, useState } from "react"
import { deskText } from "../../../shared/desk-ui"
import type { MailLang } from "../../../shared/mail"
import { DEFAULT_LICENSE_SERVER_URL, type AccountView, type Settings } from "../../../shared/types"
import { Banner, Field, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function AccountGate({ lang, settings, onSettings, onDone }: {
  lang: MailLang
  settings: Settings
  onSettings: (next: Settings) => void
  onDone: (account: AccountView) => void
}) {
  const [mode, setMode] = useState<"signIn" | "create">("signIn")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [server, setServer] = useState(settings.licenseServerUrl || DEFAULT_LICENSE_SERVER_URL)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setServer(settings.licenseServerUrl || DEFAULT_LICENSE_SERVER_URL)
  }, [settings.licenseServerUrl])

  async function rememberServer() {
    const next = server.trim() || DEFAULT_LICENSE_SERVER_URL
    if (next === (settings.licenseServerUrl || DEFAULT_LICENSE_SERVER_URL)) return
    const saved = await unwrap(window.aio.settings.save({ ...settings, licenseServerUrl: next }))
    onSettings(saved.settings)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await rememberServer()
      const account = mode === "create"
        ? await unwrap(window.aio.account.signUp({ email: email.trim(), password }))
        : await unwrap(window.aio.account.signIn({ email: email.trim(), password }))
      onDone(account)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page wizard">
      <header className="page-head">
        <div>
          <h1>{deskText(lang, mode === "create" ? "createTitle" : "signInTitle")}</h1>
          <p>{deskText(lang, mode === "create" ? "createHint" : "signInHint")}</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <form className="card stack" onSubmit={(event) => void submit(event)}>
        <Field label={deskText(lang, "fieldServer")}>
          <TextInput value={server} autoComplete="off" onChange={(event) => setServer(event.target.value)} required />
        </Field>
        <Field label={deskText(lang, "fieldEmail")}>
          <TextInput type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </Field>
        <Field label={deskText(lang, "fieldPassword")}>
          <TextInput type="password" autoComplete={mode === "create" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required />
        </Field>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>{deskText(lang, mode === "create" ? "createTitle" : "signInTitle")}</button>
          <button type="button" onClick={() => { setMode(mode === "create" ? "signIn" : "create"); setError("") }}>
            {deskText(lang, mode === "create" ? "haveKey" : "haveAccount")}
          </button>
        </div>
      </form>
    </section>
  )
}

export function WaitingAccount({ lang, account, onReady, onSignedOut }: {
  lang: MailLang
  account: AccountView
  onReady: (account: AccountView) => void
  onSignedOut: () => void
}) {
  const [key, setKey] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => {
      void unwrap(window.aio.account.status()).then((next) => {
        if (next.signedIn && !next.pending) onReady(next)
      }).catch(() => undefined)
    }, 8000)
    return () => window.clearInterval(timer)
  }, [onReady])

  async function redeem(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const next = await unwrap(window.aio.account.redeem({ key: key.trim() }))
      if (next.signedIn && !next.pending) onReady(next)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page wizard">
      <header className="page-head">
        <div>
          <h1>{deskText(lang, "waitingTitle")}</h1>
          <p>{deskText(lang, "waitingHint")}</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className="card stack">
        <p>{account.email}</p>
        <p className="hint">{deskText(lang, "waitingTitle")}</p>
      </div>
      <form className="card stack" onSubmit={(event) => void redeem(event)}>
        <Field label={deskText(lang, "fieldLicense")}>
          <TextInput value={key} autoComplete="off" onChange={(event) => setKey(event.target.value)} />
        </Field>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !key.trim()}>{deskText(lang, "redeemKey")}</button>
          <button type="button" onClick={() => void unwrap(window.aio.account.signOut()).then(() => onSignedOut()).catch((err) => setError(errorText(err)))}>{deskText(lang, "waitingSignOut")}</button>
        </div>
      </form>
    </section>
  )
}
