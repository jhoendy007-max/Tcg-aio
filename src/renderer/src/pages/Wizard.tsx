import { useEffect, useState } from "react"
import type { ProfileInput, Settings, StoreInfo } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

const STEPS = ["Welcome", "Profile", "Account", "Proxies", "Test task"] as const

function blankAddress() {
  return { firstName: "", lastName: "", line1: "", line2: "", city: "", state: "", zip: "", country: "US" as const }
}

export function Wizard({ onDone }: { onDone: (settings: Settings) => void }) {
  const [step, setStep] = useState(0)
  const [stores, setStores] = useState<StoreInfo[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [profileId, setProfileId] = useState("")
  const [accountId, setAccountId] = useState("")
  const [accountStore, setAccountStore] = useState<StoreInfo["id"]>("target")
  const [proxyGroupId, setProxyGroupId] = useState<string | null>(null)
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
  const [proxies, setProxies] = useState("")
  const [sku, setSku] = useState("")

  useEffect(() => {
    void unwrap(window.aio.stores.list()).then(setStores).catch((err) => setError(errorText(err)))
  }, [])

  async function finish(settingsPatch: Partial<Settings> = {}) {
    const current = await unwrap(window.aio.settings.get())
    const saved = await unwrap(window.aio.settings.save({ ...current.settings, ...settingsPatch, wizardDone: true }))
    onDone(saved.settings)
  }

  async function skip() {
    setBusy(true)
    setError("")
    try {
      await finish()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault()
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

  async function saveProxies(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const text = proxies.trim()
      if (text) {
        const group = await unwrap(window.aio.proxies.save({ name: "Home", text }))
        setProxyGroupId(group.id)
      }
      setStep(4)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveTask(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await unwrap(window.aio.tasks.save({
        store: accountStore,
        sku,
        quantity: 1,
        profileId,
        accountId,
        proxyGroupId,
        confirmPurchase: false,
        testMode: true,
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
  return (
    <section className="page wizard">
      <header className="page-head">
        <div>
          <h1>Set up this PC</h1>
          <p>Step {step + 1} of {STEPS.length}. {STEPS[step]}. You can skip and fill these in later. The first task stays in test mode, so it cannot place an order.</p>
        </div>
        <button type="button" onClick={() => void skip()} disabled={busy}>Skip setup</button>
      </header>
      <ol className="steps" aria-label="Setup progress">
        {STEPS.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined} title={label} />)}
      </ol>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {step === 0 ? (
        <div className="card stack">
          <h2>Welcome</h2>
          <p>TCGAIO keeps the card, passwords, and store sessions on this computer. The phone and the browser extension only control what you pair.</p>
          <p>This wizard saves a shipping profile, a store account, an optional proxy list, and one test-mode task.</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => setStep(1)}>Start</button>
          </div>
        </div>
      ) : null}
      {step === 1 ? (
        <form className="card form-grid" onSubmit={saveProfile}>
          <Field label="Profile name"><TextInput value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} required /></Field>
          <Field label="Email"><TextInput type="email" value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} required /></Field>
          <Field label="Phone"><TextInput value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} required /></Field>
          <Field label="Card name"><TextInput value={profile.cardName} onChange={(event) => setProfile({ ...profile, cardName: event.target.value })} required /></Field>
          <Field label="First name"><TextInput value={ship.firstName} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, firstName: event.target.value } })} required /></Field>
          <Field label="Last name"><TextInput value={ship.lastName} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, lastName: event.target.value } })} required /></Field>
          <Field className="span-2" label="Street"><TextInput value={ship.line1} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, line1: event.target.value } })} required /></Field>
          <Field label="City"><TextInput value={ship.city} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, city: event.target.value } })} required /></Field>
          <Field label="State"><TextInput maxLength={2} value={ship.state} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, state: event.target.value } })} required /></Field>
          <Field label="ZIP"><TextInput value={ship.zip} onChange={(event) => setProfile({ ...profile, shipping: { ...ship, zip: event.target.value } })} required /></Field>
          <Field label="Card number"><TextInput inputMode="numeric" autoComplete="off" value={profile.cardNumber} onChange={(event) => setProfile({ ...profile, cardNumber: event.target.value })} required /></Field>
          <Field label="Exp month"><TextInput value={profile.expMonth} onChange={(event) => setProfile({ ...profile, expMonth: event.target.value })} placeholder="12" required /></Field>
          <Field label="Exp year"><TextInput value={profile.expYear} onChange={(event) => setProfile({ ...profile, expYear: event.target.value })} placeholder="2030" required /></Field>
          <Field label="CVV"><TextInput value={profile.cvv} onChange={(event) => setProfile({ ...profile, cvv: event.target.value })} autoComplete="off" required /></Field>
          <div className="actions span-2">
            <button type="button" onClick={() => setStep(0)}>Back</button>
            <button className="primary" type="submit" disabled={busy}>Save profile</button>
          </div>
        </form>
      ) : null}
      {step === 2 ? (
        <form className="card form-grid" onSubmit={saveAccount}>
          <Field label="Store">
            <Select value={account.store} onChange={(event) => setAccount({ ...account, store: event.target.value as StoreInfo["id"] })}>
              {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
            </Select>
          </Field>
          <Field label="Label"><TextInput value={account.label} onChange={(event) => setAccount({ ...account, label: event.target.value })} required /></Field>
          <Field label="Account email"><TextInput type="email" value={account.username} onChange={(event) => setAccount({ ...account, username: event.target.value })} required /></Field>
          <Field label="Password"><TextInput type="password" autoComplete="new-password" value={account.password} onChange={(event) => setAccount({ ...account, password: event.target.value })} required /></Field>
          <p className="span-2 hint">The password stays encrypted on this PC. Sign in later from Accounts or Session Keeper. This step does not open the store.</p>
          <div className="actions span-2">
            <button type="button" onClick={() => setStep(1)}>Back</button>
            <button className="primary" type="submit" disabled={busy}>Save account</button>
          </div>
        </form>
      ) : null}
      {step === 3 ? (
        <form className="card stack" onSubmit={saveProxies}>
          <Field label="Proxy list" hint="Optional. One proxy per line, host:port or host:port:user:pass. Leave this blank to use a direct connection.">
            <textarea rows={5} value={proxies} onChange={(event) => setProxies(event.target.value)} placeholder="203.0.113.10:8000" />
          </Field>
          <div className="actions">
            <button type="button" onClick={() => setStep(2)}>Back</button>
            <button className="primary" type="submit" disabled={busy}>{proxies.trim() ? "Save proxies" : "Continue without proxies"}</button>
          </div>
        </form>
      ) : null}
      {step === 4 ? (
        <form className="card stack" onSubmit={saveTask}>
          <Field label="Product SKU or URL" hint="This task is created in test mode. Confirm purchase stays off, so place order is not sent.">
            <TextInput value={sku} onChange={(event) => setSku(event.target.value)} required placeholder="SKU or product URL" />
          </Field>
          <label className="check">
            <input type="checkbox" checked disabled />
            <span>Test mode is on for this task. It cannot place an order.</span>
          </label>
          <div className="actions">
            <button type="button" onClick={() => setStep(3)}>Back</button>
            <button className="primary" type="submit" disabled={busy}>Create test task</button>
          </div>
        </form>
      ) : null}
    </section>
  )
}
