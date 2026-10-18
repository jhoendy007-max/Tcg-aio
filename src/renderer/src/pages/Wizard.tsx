import { useEffect, useState } from "react"
import { deskText, wizardIssues, wizardSteps } from "../../../shared/desk-ui"
import type { MailLang } from "../../../shared/mail"
import type { ProfileInput, Settings, StoreInfo } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

function blankAddress() {
  return { firstName: "", lastName: "", line1: "", line2: "", city: "", state: "", zip: "", country: "US" as const }
}

export function Wizard({ lang, onDone }: { lang: MailLang; onDone: (settings: Settings) => void }) {
  const steps = wizardSteps()
  const [step, setStep] = useState(0)
  const [stores, setStores] = useState<StoreInfo[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [licenseKey, setLicenseKey] = useState("")
  const [profileId, setProfileId] = useState("")
  const [accountId, setAccountId] = useState("")
  const [accountStore, setAccountStore] = useState<StoreInfo["id"]>("target")
  const [profile, setProfile] = useState<ProfileInput>({
    name: "",
    email: "",
    phone: "",
    shipping: blankAddress(),
    billing: blankAddress(),
    cardName: "",
    cardNumber: "",
    expMonth: "",
    expYear: "",
    cvv: "",
    cardAction: "replace"
  })
  const [account, setAccount] = useState({ label: "", username: "", password: "", store: "target" as StoreInfo["id"] })
  const [sku, setSku] = useState("")
  const name = steps[step]

  useEffect(() => {
    void unwrap(window.aio.stores.list()).then(setStores).catch((err) => setError(errorText(err)))
  }, [])

  async function finish() {
    const current = await unwrap(window.aio.settings.get())
    const saved = await unwrap(window.aio.settings.save({ ...current.settings, wizardDone: true }))
    onDone(saved.settings)
  }

  async function skip() {
    setBusy(true)
    setError("")
    try { await finish() } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  async function saveLicense(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      if (licenseKey.trim()) await unwrap(window.aio.license.activate(licenseKey.trim()))
      setStep(1)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault()
    const ship = profile.shipping
    const issues = wizardIssues("profile", { email: profile.email, phone: profile.phone, card: profile.cardNumber, line1: ship.line1, city: ship.city, state: ship.state, zip: ship.zip }, lang)
    if (issues.length) { setError(issues[0]); return }
    setBusy(true)
    setError("")
    try {
      const saved = await unwrap(window.aio.profiles.save({ ...profile, billing: profile.shipping, cardAction: "replace" }))
      setProfileId(saved.id)
      setStep(2)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveAccount(event: React.FormEvent) {
    event.preventDefault()
    const issues = wizardIssues("account", account, lang)
    if (issues.length) { setError(issues[0]); return }
    setBusy(true)
    setError("")
    try {
      const saved = await unwrap(window.aio.accounts.save({
        store: account.store,
        label: account.label,
        username: account.username,
        password: account.password,
        passwordAction: "replace",
        session: "",
        sessionAction: "keep"
      }))
      setAccountId(saved.id)
      setAccountStore(saved.store)
      setStep(3)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveTask(event: React.FormEvent) {
    event.preventDefault()
    const issues = wizardIssues("task", { sku }, lang)
    if (issues.length) { setError(issues[0]); return }
    setBusy(true)
    setError("")
    try {
      await unwrap(window.aio.tasks.save({
        store: accountStore,
        sku,
        quantity: 1,
        profileId,
        accountId,
        proxyGroupId: null,
        confirmPurchase: false,
        testMode: true,
        kind: "checkout",
        group: "First drop"
      }))
      await finish()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const ship = profile.shipping
  const titles = { license: "stepLicense", profile: "stepProfile", account: "stepAccount", task: "stepTask" } as const
  return (
    <section className="page wizard">
      <header className="page-head">
        <div>
          <h1>{deskText(lang, "wizardTitle")}</h1>
          <p>{deskText(lang, titles[name])} · {step + 1} / {steps.length}</p>
        </div>
        <button type="button" onClick={() => void skip()} disabled={busy}>{deskText(lang, "wizardSkip")}</button>
      </header>
      <ol className="steps" aria-label="Setup progress">
        {steps.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined} title={deskText(lang, titles[label])} />)}
      </ol>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {name === "license" ? (
        <form className="card stack" onSubmit={saveLicense}>
          <h2>{deskText(lang, "licenseTitle")}</h2>
          <p className="hint">{deskText(lang, "licenseHint")}</p>
          <Field label={deskText(lang, "licenseLabel")}>
            <TextInput value={licenseKey} autoComplete="off" onChange={(event) => setLicenseKey(event.target.value)} />
          </Field>
          <div className="actions">
            <button className="primary" type="submit" disabled={busy}>{deskText(lang, "wizardNext")}</button>
          </div>
        </form>
      ) : null}
      {name === "profile" ? (
        <form className="card form-grid" onSubmit={saveProfile}>
          <div className="span-2"><h2>{deskText(lang, "profileTitle")}</h2><p className="hint">{deskText(lang, "profileHint")}</p></div>
          <Field label={deskText(lang, "fieldName")}><TextInput value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value, cardName: event.target.value })} required /></Field>
          <Field label={deskText(lang, "fieldEmail")} hint={deskText(lang, "errEmail")}><TextInput type="email" value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} required /></Field>
          <Field label={deskText(lang, "fieldPhone")}><TextInput value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} required /></Field>
          <Field label={deskText(lang, "fieldFirst")}><TextInput value={ship.firstName} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, firstName: event.target.value } })} required /></Field>
          <Field label={deskText(lang, "fieldLast")}><TextInput value={ship.lastName} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, lastName: event.target.value } })} required /></Field>
          <Field className="span-2" label={deskText(lang, "fieldStreet")}><TextInput value={ship.line1} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, line1: event.target.value } })} required /></Field>
          <Field label={deskText(lang, "fieldCity")}><TextInput value={ship.city} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, city: event.target.value } })} required /></Field>
          <Field label={deskText(lang, "fieldState")}><TextInput maxLength={2} value={ship.state} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, state: event.target.value } })} required /></Field>
          <Field label={deskText(lang, "fieldZip")}><TextInput value={ship.zip} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, zip: event.target.value } })} required /></Field>
          <Field label={deskText(lang, "fieldCard")}><TextInput inputMode="numeric" autoComplete="off" value={profile.cardNumber} onChange={(event) => setProfile({ ...profile, cardNumber: event.target.value })} required /></Field>
          <Field label={deskText(lang, "fieldMonth")}><TextInput value={profile.expMonth} onChange={(event) => setProfile({ ...profile, expMonth: event.target.value })} placeholder="12" required /></Field>
          <Field label={deskText(lang, "fieldYear")}><TextInput value={profile.expYear} onChange={(event) => setProfile({ ...profile, expYear: event.target.value })} placeholder="2030" required /></Field>
          <Field label={deskText(lang, "fieldCvv")}><TextInput value={profile.cvv} onChange={(event) => setProfile({ ...profile, cvv: event.target.value })} autoComplete="off" required /></Field>
          <div className="actions span-2">
            <button type="button" onClick={() => setStep(0)}>{deskText(lang, "wizardBack")}</button>
            <button className="primary" type="submit" disabled={busy}>{deskText(lang, "wizardNext")}</button>
          </div>
        </form>
      ) : null}
      {name === "account" ? (
        <form className="card form-grid" onSubmit={saveAccount}>
          <div className="span-2"><h2>{deskText(lang, "accountTitle")}</h2><p className="hint">{deskText(lang, "accountHint")}</p></div>
          <Field label={deskText(lang, "fieldStore")}>
            <Select value={account.store} onChange={(event) => setAccount({ ...account, store: event.target.value as StoreInfo["id"] })}>
              {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
            </Select>
          </Field>
          <Field label={deskText(lang, "fieldName")}><TextInput value={account.label} onChange={(event) => setAccount({ ...account, label: event.target.value })} required /></Field>
          <Field label={deskText(lang, "fieldEmail")}><TextInput type="email" value={account.username} onChange={(event) => setAccount({ ...account, username: event.target.value })} required /></Field>
          <Field label={deskText(lang, "fieldPassword")}><TextInput type="password" autoComplete="new-password" value={account.password} onChange={(event) => setAccount({ ...account, password: event.target.value })} required /></Field>
          <div className="actions span-2">
            <button type="button" onClick={() => setStep(1)}>{deskText(lang, "wizardBack")}</button>
            <button className="primary" type="submit" disabled={busy}>{deskText(lang, "wizardNext")}</button>
          </div>
        </form>
      ) : null}
      {name === "task" ? (
        <form className="card stack" onSubmit={saveTask}>
          <h2>{deskText(lang, "taskTitle")}</h2>
          <p className="hint">{deskText(lang, "taskHint")}</p>
          <Field label={deskText(lang, "fieldProduct")}>
            <TextInput value={sku} onChange={(event) => setSku(event.target.value)} placeholder="https://..." />
          </Field>
          <div className="actions">
            <button type="button" onClick={() => setStep(2)}>{deskText(lang, "wizardBack")}</button>
            <button className="primary" type="submit" disabled={busy}>{deskText(lang, "wizardNext")}</button>
          </div>
        </form>
      ) : null}
    </section>
  )
}
