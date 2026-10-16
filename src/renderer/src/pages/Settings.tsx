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

  useEffect(() => {
    void unwrap(window.aio.settings.get())
      .then((next) => {
        setPayload(next)
        setForm(next.settings)
      })
      .catch((err) => setError(errorText(err)))
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
    </section>
  )
}
