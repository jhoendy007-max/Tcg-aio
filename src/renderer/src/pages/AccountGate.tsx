import { useState } from "react"
import { deskText } from "../../../shared/desk-ui"
import type { MailLang } from "../../../shared/mail"
import { Banner, Field, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function AccountGate({ lang, onSignedIn }: { lang: MailLang; onSignedIn: () => void }) {
  const [mode, setMode] = useState<"signIn" | "create">("signIn")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [key, setKey] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      if (mode === "create") await unwrap(window.aio.account.signUp({ email: email.trim(), password, key: key.trim() }))
      else await unwrap(window.aio.account.signIn({ email: email.trim(), password }))
      onSignedIn()
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
        {mode === "create" ? (
          <Field label={deskText(lang, "fieldLicense")}>
            <TextInput value={key} autoComplete="off" onChange={(event) => setKey(event.target.value)} required />
          </Field>
        ) : null}
        <Field label={deskText(lang, "fieldEmail")}>
          <TextInput type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </Field>
        <Field label={deskText(lang, "fieldPassword")}>
          <TextInput type="password" autoComplete={mode === "create" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required />
        </Field>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>{deskText(lang, mode === "create" ? "createTitle" : "signInTitle")}</button>
          <button type="button" onClick={() => { setMode(mode === "create" ? "signIn" : "create"); setError("") }}>
            {deskText(lang, mode === "create" ? "haveAccount" : "haveKey")}
          </button>
        </div>
      </form>
    </section>
  )
}
