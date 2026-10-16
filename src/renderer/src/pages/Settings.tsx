import { useEffect, useState } from "react"
import { DEFAULT_SETTINGS, type Settings, type SettingsPayload } from "../../../shared/types"
import { Banner, Field, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function SettingsPage() {
  const [payload, setPayload] = useState<SettingsPayload | null>(null)
  const [form, setForm] = useState<Settings>(DEFAULT_SETTINGS)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState("")
  const [hasToken, setHasToken] = useState(false)

  useEffect(() => {
    void unwrap(window.aio.settings.get())
      .then((next) => {
        setPayload(next)
        setForm(next.settings)
      })
      .catch((err) => setError(errorText(err)))
    void unwrap(window.aio.updates.get()).then((status) => setHasToken(status.hasToken)).catch(() => undefined)
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const next = await unwrap(window.aio.settings.save(form))
      setPayload(next)
      setForm(next.settings)
      setMessage("Settings saved.")
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function testWebhook() {
    setBusy(true)
    setError("")
    setMessage("")
    try {
      await unwrap(window.aio.settings.save(form))
      await unwrap(window.aio.settings.testWebhook())
      setMessage("Test notification sent.")
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Notifications and the Target monitor location. Stock is checked for ship-to-home near the store and ZIP below.</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      {payload ? <div className="card security">{payload.security.description}</div> : null}
      <form className="card form-grid" onSubmit={save}>
        <Field className="span-2" label="Discord webhook" hint="https://discord.com/api/webhooks/… Success, failure, and challenge pauses are posted here. Card data is not.">
          <TextInput value={form.discordWebhook} onChange={(event) => setForm({ ...form, discordWebhook: event.target.value })} placeholder="https://discord.com/api/webhooks/..." />
        </Field>
        <label className="check span-2">
          <input type="checkbox" checked={form.testMode} onChange={(event) => setForm({ ...form, testMode: event.target.checked })} />
          <span>Test mode for every task. The real flow runs through payment and stops before place order. Nothing is charged.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.clearCartAfterTest} onChange={(event) => setForm({ ...form, clearCartAfterTest: event.target.checked })} />
          <span>After a passed test, remove the test line from the Target or Walmart cart. Other stores leave the cart for you.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.sessionWarmup} onChange={(event) => setForm({ ...form, sessionWarmup: event.target.checked })} />
          <span>Session Keeper. The PC opens the store homepage and one product page in the real browser, then saves the cookies that browser already has. The Session Keeper page shows each account.</span>
        </label>
        <Field label="Session Keeper interval (minutes)" hint="How often each signed-in account is opened. 10–240. An expired session asks you to sign in again.">
          <TextInput type="number" min={10} max={240} value={form.sessionWarmupMin} onChange={(event) => setForm({ ...form, sessionWarmupMin: Number(event.target.value) })} required />
        </Field>
        <Field label="Monitor jitter (%)" hint="Random spread around each monitor wait. 0–40. Blocks (403, 412, 429, 435) also back off.">
          <TextInput type="number" min={0} max={40} value={form.monitorJitterPct} onChange={(event) => setForm({ ...form, monitorJitterPct: Number(event.target.value) })} required />
        </Field>
        <Field label="Challenge timeout (seconds)" hint="How long a person has to solve a store challenge before the task pauses. 30–600.">
          <TextInput type="number" min={30} max={600} value={form.challengeTimeoutSec} onChange={(event) => setForm({ ...form, challengeTimeoutSec: Number(event.target.value) })} required />
        </Field>
        <Field label="Monitor delay (ms)" hint="How long to wait between stock checks. 1000–60000.">
          <TextInput type="number" min={1000} max={60000} value={form.monitorDelayMs} onChange={(event) => setForm({ ...form, monitorDelayMs: Number(event.target.value) })} required />
        </Field>
        <Field label="Target store ID"><TextInput value={form.targetStoreId} onChange={(event) => setForm({ ...form, targetStoreId: event.target.value })} required /></Field>
        <Field label="Target ZIP"><TextInput value={form.targetZip} onChange={(event) => setForm({ ...form, targetZip: event.target.value })} required /></Field>
        <Field label="Target state"><TextInput value={form.targetState} maxLength={2} onChange={(event) => setForm({ ...form, targetState: event.target.value })} required /></Field>
        <Field label="Target API key" hint="Leave blank to use the key embedded in Target's web app. It can change when the site deploys.">
          <TextInput value={form.targetApiKey} onChange={(event) => setForm({ ...form, targetApiKey: event.target.value })} autoComplete="off" />
        </Field>
        <div className="actions span-2">
          <button className="primary" type="submit" disabled={busy}>Save settings</button>
          <button type="button" onClick={() => void testWebhook()} disabled={busy}>Send test webhook</button>
        </div>
      </form>
      <form className="card stack" onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setError("")
        void unwrap(window.aio.updates.saveToken({ action: token ? "replace" : "clear", token }))
          .then(async (status) => {
            setHasToken(status.hasToken)
            setToken("")
            if (status.hasToken) await unwrap(window.aio.updates.check())
            setMessage(status.hasToken ? "GitHub token saved on this PC. Checking releases." : "GitHub token removed.")
          })
          .catch((err) => setError(errorText(err)))
          .finally(() => setBusy(false))
      }}>
        <div>
          <h2>Updates</h2>
          <p className="hint">The GitHub repo is private, so electron-updater needs a personal access token that can read releases. The token stays on this PC and is not sent to the phone. Leave the field blank and save to remove it. A newer desktop build shows a prompt with the release notes. The phone shows when a newer APK is on that release.</p>
        </div>
        <Field label="GitHub token" hint={hasToken ? "A token is saved. Paste a new one to replace it." : "No token saved yet."}>
          <TextInput type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="github_pat_…" />
        </Field>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>{token ? "Save token" : "Remove token"}</button>
          <button type="button" disabled={busy} onClick={() => void unwrap(window.aio.updates.check()).then(() => setMessage("Update check finished.")).catch((err) => setError(errorText(err)))}>Check for updates</button>
        </div>
      </form>
    </section>
  )
}
