import { useEffect, useState } from "react"
import { healthText } from "../../../shared/checkout-health"
import { consistencyText } from "../../../shared/consistency"
import { dropOpsText } from "../../../shared/drop-ops"
import { DEFAULT_LICENSE_SERVER_URL, DEFAULT_SETTINGS, type AccountView, type Settings, type SettingsPayload, type UpdateStatus } from "../../../shared/types"
import { updateStatusText } from "../../../shared/update-status"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { MailSettings } from "./MailSettings"
import { applyTheme } from "../theme"
import { errorText, unwrap } from "../lib"

export function SettingsPage() {
  const [payload, setPayload] = useState<SettingsPayload | null>(null)
  const [form, setForm] = useState<Settings>(DEFAULT_SETTINGS)
  const [advancedOpen, setAdvancedOpen] = useState(() => typeof location !== "undefined" && location.hash === "#settings/advanced")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState("")
  const [hasToken, setHasToken] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [passphrase, setPassphrase] = useState("")
  const [backupToken, setBackupToken] = useState("")
  const [hasBackupToken, setHasBackupToken] = useState(false)
  const [account, setAccount] = useState<AccountView | null>(null)

  useEffect(() => {
    void unwrap(window.aio.settings.get())
      .then((next) => {
        setPayload(next)
        setForm({ ...next.settings, licenseServerUrl: next.settings.licenseServerUrl || DEFAULT_LICENSE_SERVER_URL })
      })
      .catch((err) => setError(errorText(err)))
    void unwrap(window.aio.updates.get()).then((status) => { setHasToken(status.hasToken); setUpdate(status) }).catch(() => undefined)
    void unwrap(window.aio.backup.saveToken({ action: "keep", token: "" })).then((status) => setHasBackupToken(status.hasToken)).catch(() => undefined)
    void unwrap(window.aio.account.status()).then(setAccount).catch(() => undefined)
    return window.aio.updates.onEvent((status) => { setUpdate(status); setHasToken(status.hasToken) })
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
      applyTheme(next.settings)
      window.dispatchEvent(new CustomEvent("tcgaio-settings", { detail: next.settings }))
      setMessage("Settings saved.")
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function readLogo(file: File | undefined) {
    setError("")
    if (!file) return
    if (file.size > 90_000) {
      setError("The logo image is too large. Use a file under about 80 KB.")
      return
    }
    const mime = file.type === "image/png" || file.type === "image/jpeg" || file.type === "image/webp" ? file.type : ""
    if (!mime) {
      setError("The logo has to be a PNG, JPEG, or WebP image.")
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    setForm((current) => ({ ...current, logoDataUrl: `data:${mime};base64,${btoa(binary)}` }))
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
          <p>The basics. Everything technical is under Advanced.</p>
        </div>
      </header>
      {error && !/public key/i.test(error) ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      {account?.signedIn ? (
        <div className="card stack">
          <h2>{account.role === "owner" ? "Owner" : "Signed in"}</h2>
          <p className="hint">{account.email} · {account.plan || "standard"}{account.expiresAt ? ` · until ${new Date(account.expiresAt).toLocaleDateString()}` : ""} · PC {account.fingerprint || "this PC"}</p>
          <div className="actions">
            {account.role === "owner" ? <button type="button" className="primary" onClick={() => void unwrap(window.aio.account.openAdmin()).catch((err) => setError(errorText(err)))}>Open admin desk</button> : null}
            <button type="button" onClick={() => void unwrap(window.aio.account.transfer()).then(setAccount).catch((err) => setError(errorText(err)))}>Move to this PC</button>
            <button type="button" onClick={() => void unwrap(window.aio.account.signOut()).then(() => { setAccount(null); window.dispatchEvent(new Event("tcgaio-signout")) }).catch((err) => setError(errorText(err)))}>Sign out</button>
          </div>
          {account.role === "owner" ? <p className="hint">Owner debug: this signed-in role comes from the license server, not from the email typed on this PC.</p> : null}
        </div>
      ) : null}
      <form className="card form-grid" onSubmit={save}>
        <div className="span-2">
          <h2>Appearance</h2>
          <p className="hint">Theme, accent, and the name in the sidebar. The logo stays on this PC.</p>
        </div>
        <Field label="Theme">
          <Select value={form.theme} onChange={(event) => { const theme: Settings["theme"] = event.target.value === "light" ? "light" : "dark"; const next = { ...form, theme }; setForm(next); applyTheme(next) }}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </Select>
        </Field>
        <Field label="Task table">
          <Select value={form.taskView} onChange={(event) => setForm({ ...form, taskView: event.target.value === "compact" ? "compact" : "detailed" })}>
            <option value="detailed">Detailed</option>
            <option value="compact">Compact</option>
          </Select>
        </Field>
        <fieldset className="span-2">
          <legend>Accent</legend>
          <div className="swatches">
            {(["gold", "blue", "green", "rose"] as const).map((accent) => (
              <label key={accent} className="swatch">
                <input type="radio" name="accent" value={accent} checked={form.accent === accent} onChange={() => { const next = { ...form, accent }; setForm(next); applyTheme(next) }} />
                <span>{accent}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="App name" hint="Shown in the sidebar. Up to 24 characters.">
          <TextInput value={form.appName} maxLength={24} onChange={(event) => setForm({ ...form, appName: event.target.value })} />
        </Field>
        <Field label="Logo" hint="PNG, JPEG, or WebP under about 80 KB. Leave it empty to keep the mark.">
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void readLogo(event.target.files?.[0])} />
        </Field>
        {form.logoDataUrl ? <img className="brand-logo" src={form.logoDataUrl} alt="Current logo" /> : null}
        {form.logoDataUrl ? <button type="button" onClick={() => setForm({ ...form, logoDataUrl: "" })}>Remove logo</button> : null}
        <label className="check span-2">
          <input type="checkbox" checked={form.successSound} onChange={(event) => setForm({ ...form, successSound: event.target.checked })} />
          <span>Play a short sound when a checkout succeeds. This stays off until you turn it on.</span>
        </label>
        <Field className="span-2" label="Discord webhook" hint="https://discord.com/api/webhooks/… Success, failure, and challenge pauses are posted here. Card data is not.">
          <TextInput value={form.discordWebhook} onChange={(event) => setForm({ ...form, discordWebhook: event.target.value })} placeholder="https://discord.com/api/webhooks/..." />
        </Field>
        <Field label="Monitor delay (ms)" hint="Wait between stock checks outside a drop window. 1000–60000.">
          <TextInput type="number" min={1000} max={60000} value={form.monitorDelayMs} onChange={(event) => setForm({ ...form, monitorDelayMs: Number(event.target.value) })} required />
        </Field>
        <label className="check span-2">
          <input type="checkbox" checked={form.testMode} onChange={(event) => setForm({ ...form, testMode: event.target.checked })} />
          <span>Test mode for every task. The real flow runs through payment and stops before place order. Nothing is charged.</span>
        </label>
        <details className="advanced span-2" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}>
          <summary>Advanced</summary>
          <div className="form-grid">
        <label className="check span-2">
          <input type="checkbox" checked={form.groupDiscord} onChange={(event) => setForm({ ...form, groupDiscord: event.target.checked })} />
          <span>Also post restocks and successful checkouts to a shared group webhook. This stays off until you turn it on. The group post leaves out profile, email, card, and proxy details.</span>
        </label>
        <Field className="span-2" label="Group webhook" hint="A different https://discord.com/api/webhooks/… URL. Nothing is sent here while the switch above is off.">
          <TextInput value={form.groupWebhook} onChange={(event) => setForm({ ...form, groupWebhook: event.target.value })} placeholder="https://discord.com/api/webhooks/..." />
        </Field>
        <label className="check span-2">
          <input type="checkbox" checked={form.clearCartAfterTest} onChange={(event) => setForm({ ...form, clearCartAfterTest: event.target.checked })} />
          <span>After a passed test, remove the test line from the Target or Walmart cart. Other stores leave the cart for you.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.sessionWarmup} onChange={(event) => setForm({ ...form, sessionWarmup: event.target.checked })} />
          <span>Session Keeper. The PC opens the store homepage and one product page in the real browser, then saves the cookies that browser already has. The Session Keeper page shows each account.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.warmOnStart} onChange={(event) => setForm({ ...form, warmOnStart: event.target.checked })} />
          <span>Warm the account when a monitor or checkout starts, if that session is older than the Session Keeper interval. A scheduled drop still warms the accounts named on the drop, using the drop's warm-up minutes. Nothing is added to cart.</span>
        </label>
        <Field label="Session Keeper interval (minutes)" hint="How often each signed-in account is opened. 10–240. An expired session asks you to sign in again.">
          <TextInput type="number" min={10} max={240} value={form.sessionWarmupMin} onChange={(event) => setForm({ ...form, sessionWarmupMin: Number(event.target.value) })} required />
        </Field>
        <Field label={consistencyText(form.language === "es" ? "es" : "en", "windowCap")} hint={consistencyText(form.language === "es" ? "es" : "en", "windowCapHint")}>
          <TextInput type="number" min={1} max={10} value={form.sessionWindowCap} onChange={(event) => setForm({ ...form, sessionWindowCap: Number(event.target.value) })} required />
        </Field>
        <Field label="Monitor jitter (%)" hint="Random spread around each monitor wait. 0–40. Blocks (403, 412, 429, 435) also back off.">
          <TextInput type="number" min={0} max={40} value={form.monitorJitterPct} onChange={(event) => setForm({ ...form, monitorJitterPct: Number(event.target.value) })} required />
        </Field>
        <Field label="Challenge timeout (seconds)" hint="How long a person has to solve a store challenge before the task pauses. 30–600.">
          <TextInput type="number" min={30} max={600} value={form.challengeTimeoutSec} onChange={(event) => setForm({ ...form, challengeTimeoutSec: Number(event.target.value) })} required />
        </Field>
        <Field label="Fast delay (ms)" hint="Used inside a drop window. Each store still waits at least its own gap.">
          <TextInput type="number" min={250} max={60000} value={form.monitorFastDelayMs} onChange={(event) => setForm({ ...form, monitorFastDelayMs: Number(event.target.value) })} required />
        </Field>
        <Field label="Block retries" hint="HTTP 429 waits and retries on the same connection. Checkout: HTTP 403, 412, or 435 reloads the account browser on the same sticky proxy. Monitors never use a browser: they move to the next proxy, or wait longer with a single proxy. A challenge page waits for you in the account browser. 1–8.">
          <TextInput type="number" min={1} max={8} value={form.blockRetries} onChange={(event) => setForm({ ...form, blockRetries: Number(event.target.value) })} required />
        </Field>
        <Field className="span-2" label="Drop windows" hint="Atlantic Time, one range per line, like 09:00-09:20. Scheduled drops are windows too.">
          <TextInput value={form.dropWindows} onChange={(event) => setForm({ ...form, dropWindows: event.target.value })} placeholder="09:00-09:20" />
        </Field>
        <Field label="Extra monitor ZIPs" hint="Target checks each ZIP. Other stores use the signed-in location.">
          <TextInput value={form.monitorZips} onChange={(event) => setForm({ ...form, monitorZips: event.target.value })} placeholder="10001, 90210" />
        </Field>
        <Field label="Extra store ids" hint="Paired with the ZIPs above for Target.">
          <TextInput value={form.monitorStoreIds} onChange={(event) => setForm({ ...form, monitorStoreIds: event.target.value })} placeholder="1881, 3244" />
        </Field>
        <label className="check span-2">
          <input type="checkbox" checked={form.autopilot} onChange={(event) => setForm({ ...form, autopilot: event.target.checked })} />
          <span>Autopilot. Saved templates can start when a restock alert, keyword hit, or learned restock hour matches. The global off switch stops new starts.</span>
        </label>
        <Field label="Autopilot price cap" hint="0 uses only the cap on each template.">
          <TextInput type="number" min={0} value={form.autopilotPriceCap} onChange={(event) => setForm({ ...form, autopilotPriceCap: Number(event.target.value) })} />
        </Field>
        <Field label="Stuck task (minutes)" hint="Restart a running task that has not logged anything. 5–120.">
          <TextInput type="number" min={5} max={120} value={form.stuckMinutes} onChange={(event) => setForm({ ...form, stuckMinutes: Number(event.target.value) })} />
        </Field>
        <label className="check span-2">
          <input type="checkbox" checked={form.launchOnBoot} onChange={(event) => setForm({ ...form, launchOnBoot: event.target.checked })} />
          <span>Launch Zzz AIO when Windows starts. This stays off until you turn it on.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.resumeOnLaunch} onChange={(event) => setForm({ ...form, resumeOnLaunch: event.target.checked })} />
          <span>After a crash, resume tasks that were still running.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.relaunchOnCrash} onChange={(event) => setForm({ ...form, relaunchOnCrash: event.target.checked })} />
          <span>Relaunch the app after an unexpected error, at most once a minute.</span>
        </label>
        <Field label="Daily budget" hint="0 means no cap. A checkout over the cap is not sent.">
          <TextInput type="number" min={0} value={form.dailyBudget} onChange={(event) => setForm({ ...form, dailyBudget: Number(event.target.value) })} />
        </Field>
        <Field label="Drop budget" hint="0 means no cap. Applies while a scheduled drop is running.">
          <TextInput type="number" min={0} value={form.dropBudget} onChange={(event) => setForm({ ...form, dropBudget: Number(event.target.value) })} />
        </Field>
        <Field label="Max per SKU" hint="Successful quantity per SKU per day. 0 means no cap.">
          <TextInput type="number" min={0} max={99} value={form.maxPerSku} onChange={(event) => setForm({ ...form, maxPerSku: Number(event.target.value) })} />
        </Field>
        <Field label="Max per account" hint="Successful orders per account per day. 0 means no cap.">
          <TextInput type="number" min={0} max={99} value={form.maxPerAccount} onChange={(event) => setForm({ ...form, maxPerAccount: Number(event.target.value) })} />
        </Field>
        <Field label={dropOpsText(form.language, "accountSpend")} hint={dropOpsText(form.language, "accountSpendHint")}>
          <TextInput type="number" min={0} value={form.accountDailySpend} onChange={(event) => setForm({ ...form, accountDailySpend: Number(event.target.value) })} />
        </Field>
        <Field label={dropOpsText(form.language, "cardSpend")} hint={dropOpsText(form.language, "cardSpendHint")}>
          <TextInput type="number" min={0} value={form.cardDailySpend} onChange={(event) => setForm({ ...form, cardDailySpend: Number(event.target.value) })} />
        </Field>
        <Field label={dropOpsText(form.language, "cardOrders")} hint={dropOpsText(form.language, "cardOrdersHint")}>
          <TextInput type="number" min={0} max={99} value={form.cardDailyOrders} onChange={(event) => setForm({ ...form, cardDailyOrders: Number(event.target.value) })} />
        </Field>
        <Field className="span-2" label="Store purchase limits" hint="One line per store, like target:1. That is the most of one SKU an account can win today.">
          <TextInput value={form.storePurchaseLimits} onChange={(event) => setForm({ ...form, storePurchaseLimits: event.target.value })} placeholder="target:1" />
        </Field>
        <label className="check span-2">
          <input type="checkbox" checked={form.checkoutHealthBlock} onChange={(event) => setForm({ ...form, checkoutHealthBlock: event.target.checked })} />
          <span>{healthText(form.language, "blockLabel")}. {healthText(form.language, "blockHint")}</span>
        </label>
        <Field label={healthText(form.language, "limitLabel")} hint={healthText(form.language, "limitHint")}>
          <TextInput type="number" min={0} max={99} value={form.clientSkuLimit} onChange={(event) => setForm({ ...form, clientSkuLimit: Number(event.target.value) })} />
        </Field>
        <Field className="span-2" label={healthText(form.language, "addressLabel")} hint={healthText(form.language, "addressHint")}>
          <TextInput value={form.addressOrderLimits} onChange={(event) => setForm({ ...form, addressOrderLimits: event.target.value })} placeholder="target:3" />
        </Field>
        <Field label={healthText(form.language, "holdLabel")} hint={healthText(form.language, "holdHint")}>
          <TextInput type="number" min={15} max={10080} value={form.declineHoldMin} onChange={(event) => setForm({ ...form, declineHoldMin: Number(event.target.value) })} />
        </Field>
        <Field label="Health report time" hint="HH:MM in the timezone below. Blank turns the report off.">
          <TextInput value={form.healthReportTime} onChange={(event) => setForm({ ...form, healthReportTime: event.target.value })} placeholder="08:00" />
        </Field>
        <Field label="Report timezone" hint="IANA name, like America/New_York. Blank uses UTC for budgets.">
          <TextInput value={form.healthReportZone} onChange={(event) => setForm({ ...form, healthReportZone: event.target.value })} placeholder="America/New_York" />
        </Field>
        <label className="check span-2">
          <input type="checkbox" checked={form.alertPrice} onChange={(event) => setForm({ ...form, alertPrice: event.target.checked })} />
          <span>Alert when the price changes.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.alertNewOffer} onChange={(event) => setForm({ ...form, alertNewOffer: event.target.checked })} />
          <span>Alert when a new offer id appears.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.alertAvailable} onChange={(event) => setForm({ ...form, alertAvailable: event.target.checked })} />
          <span>Alert when an item changes from unavailable to add-to-cart.</span>
        </label>
        <label className="check span-2">
          <input type="checkbox" checked={form.alertRetailer} onChange={(event) => setForm({ ...form, alertRetailer: event.target.checked })} />
          <span>Alert when the retailer starts selling the item.</span>
        </label>
        <Field label="Target store ID"><TextInput value={form.targetStoreId} onChange={(event) => setForm({ ...form, targetStoreId: event.target.value })} required /></Field>
        <Field label="Target ZIP"><TextInput value={form.targetZip} onChange={(event) => setForm({ ...form, targetZip: event.target.value })} required /></Field>
        <Field label="Target state"><TextInput value={form.targetState} maxLength={2} onChange={(event) => setForm({ ...form, targetState: event.target.value })} required /></Field>
        <Field className="span-2" label="Backup URL" hint="Optional https link you control. The file stored there is ciphertext. Do not put the token in the URL.">
          <TextInput value={form.backupUrl} onChange={(event) => setForm({ ...form, backupUrl: event.target.value })} placeholder="https://example.com/tcgaio-backup" autoComplete="off" />
        </Field>
        <Field label="Target API key" hint="Leave blank to use the key embedded in Target's web app. It can change when the site deploys.">
          <TextInput value={form.targetApiKey} onChange={(event) => setForm({ ...form, targetApiKey: event.target.value })} autoComplete="off" />
        </Field>
          </div>
        </details>
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
            if (status.hasToken) setUpdate(await unwrap(window.aio.updates.check()))
            setMessage(status.hasToken ? "GitHub token saved on this PC. Checking releases." : "GitHub token removed.")
          })
          .catch((err) => setError(errorText(err)))
          .finally(() => setBusy(false))
      }}>
        <div>
          <h2>Updates</h2>
          <p className="hint">New versions show a popup with Install now or Later. You can also check here.</p>
          {update ? <p className="hint" aria-live="polite">{updateStatusText(update)}</p> : null}
          {update?.status === "downloading" ? <progress className="update-progress" value={update.percent ?? 0} max={100} /> : null}
        </div>
        <details className="advanced">
          <summary>Private repo token</summary>
        <Field label="GitHub token" hint={hasToken ? "A token is saved. Paste a new one to replace it." : "No token saved. A public repo does not need one."}>
          <TextInput type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="github_pat_…" />
        </Field>
        </details>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>{token ? "Save token" : "Remove token"}</button>
          <button type="button" disabled={busy || update?.status === "checking" || update?.status === "downloading"} onClick={() => void unwrap(window.aio.updates.check()).then((status) => { setUpdate(status); setMessage(updateStatusText(status)) }).catch((err) => setError(errorText(err)))}>{update?.status === "checking" ? "Checking…" : "Check for updates"}</button>
          {update?.status === "available" || update?.status === "downloading" ? <button type="button" disabled={busy || update.status === "downloading"} onClick={() => void unwrap(window.aio.updates.download()).then((status) => { setUpdate(status); setMessage(updateStatusText(status)) }).catch((err) => setError(errorText(err)))}>{update.status === "downloading" ? `Downloading ${Math.round(update.percent ?? 0)}%` : "Download"}</button> : null}
          {update?.status === "downloaded" ? <button type="button" className="primary" disabled={busy} onClick={() => void unwrap(window.aio.updates.install()).catch((err) => setError(errorText(err)))}>Restart and install</button> : null}
        </div>
      </form>
      <details className="advanced card" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}>
        <summary>Advanced: license server, mail, backup</summary>
      <div className="card stack">
        <h2>License server</h2>
        <Field label="Address">
          <TextInput value={form.licenseServerUrl || DEFAULT_LICENSE_SERVER_URL} autoComplete="off" onChange={(event) => setForm({ ...form, licenseServerUrl: event.target.value })} />
        </Field>
        <p className="hint">The session stays on this PC. The address starts at {DEFAULT_LICENSE_SERVER_URL} and can be changed.</p>
        <div className="actions">
          <button type="button" onClick={() => void unwrap(window.aio.settings.save({ ...form, licenseServerUrl: form.licenseServerUrl.trim() || DEFAULT_LICENSE_SERVER_URL })).then((next) => { setPayload(next); setForm({ ...next.settings, licenseServerUrl: next.settings.licenseServerUrl || DEFAULT_LICENSE_SERVER_URL }); setMessage("License server saved.") }).catch((err) => setError(errorText(err)))}>Save server</button>
        </div>
      </div>
      {payload ? <div className="card security">{payload.security.description}</div> : null}
      <MailSettings />
      <form className="card stack" onSubmit={(event) => event.preventDefault()}>
        <div>
          <h2>Encrypted backup</h2>
          <p className="hint">Settings, tasks, profiles, accounts, and proxies are sealed with your passphrase. Card numbers, passwords, and sessions stay inside that ciphertext. The passphrase is not saved, and this PC's phone pairing is not replaced on restore. A cloud copy is the same sealed file at the backup URL.</p>
        </div>
        <Field label="Passphrase" hint="8 or more characters. You need this same passphrase to restore.">
          <TextInput type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
        </Field>
        <Field label="Upload token" hint={hasBackupToken ? "A token is saved on this PC. It is not written into the backup." : "Optional. Sent only as a bearer token to your backup URL."}>
          <TextInput type="password" autoComplete="off" value={backupToken} onChange={(event) => setBackupToken(event.target.value)} />
        </Field>
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void (async () => {
            setBusy(true)
            setError("")
            setMessage("")
            try {
              const result = await unwrap(window.aio.backup.exportFile(passphrase))
              const blob = new Blob([result.file], { type: "application/octet-stream" })
              const url = URL.createObjectURL(blob)
              const link = document.createElement("a")
              link.href = url
              link.download = "tcgaio.tcgaio-backup"
              link.click()
              URL.revokeObjectURL(url)
              setPassphrase("")
              setMessage("Encrypted backup downloaded. Keep the passphrase with you, not in the file.")
            } catch (err) {
              setError(errorText(err))
            } finally {
              setBusy(false)
            }
          })()}>Download backup</button>
          <button type="button" disabled={busy} onClick={() => document.getElementById("backup-file")?.click()}>Restore from file</button>
          <input id="backup-file" type="file" accept=".tcgaio-backup,application/json" hidden onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ""
            if (!file) return
            setBusy(true)
            setError("")
            void file.text().then((text) => unwrap(window.aio.backup.restoreFile(passphrase, text))).then(() => {
              setPassphrase("")
              setMessage("Backup restored on this PC. Phone pairing was left as it was.")
              return unwrap(window.aio.settings.get())
            }).then((next) => {
              if (!next) return
              setPayload(next)
              setForm(next.settings)
              applyTheme(next.settings)
            }).catch((err) => setError(errorText(err))).finally(() => setBusy(false))
          }} />
          <button type="button" disabled={busy} onClick={() => void unwrap(window.aio.backup.saveToken({ action: backupToken ? "replace" : "clear", token: backupToken })).then((status) => {
            setHasBackupToken(status.hasToken)
            setBackupToken("")
            setMessage(status.hasToken ? "Backup token saved on this PC." : "Backup token removed.")
          }).catch((err) => setError(errorText(err)))}>{backupToken ? "Save upload token" : "Remove upload token"}</button>
          <button type="button" disabled={busy} onClick={() => void (async () => {
            setBusy(true)
            setError("")
            try {
              await unwrap(window.aio.settings.save(form))
              await unwrap(window.aio.backup.upload(passphrase))
              setPassphrase("")
              setMessage("Encrypted backup uploaded. The host received ciphertext only.")
            } catch (err) {
              setError(errorText(err))
            } finally {
              setBusy(false)
            }
          })()}>Upload</button>
          <button type="button" disabled={busy} onClick={() => void (async () => {
            setBusy(true)
            setError("")
            try {
              await unwrap(window.aio.backup.download(passphrase))
              const next = await unwrap(window.aio.settings.get())
              setPayload(next)
              setForm(next.settings)
              applyTheme(next.settings)
              setPassphrase("")
              setMessage("Encrypted backup downloaded and restored.")
            } catch (err) {
              setError(errorText(err))
            } finally {
              setBusy(false)
            }
          })()}>Download from URL</button>
        </div>
      </form>
      </details>
    </section>
  )
}
