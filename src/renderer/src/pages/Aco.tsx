import { useEffect, useState } from "react"
import { STORE_CATALOG } from "../../../shared/stores"
import type { PublicAccount, PublicProfile, StoreId } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"
import { ClientsPage } from "./Clients"

const STEPS = ["Client", "Product", "Shipping", "Confirm"] as const

interface Draft {
  name: string
  contact: string
  fee: string
  store: StoreId
  sku: string
  quantity: string
  maxPrice: string
  profileId: string
  accountId: string
}

const BLANK: Draft = { name: "", contact: "", fee: "", store: "target", sku: "", quantity: "1", maxPrice: "", profileId: "", accountId: "" }

/** Locked card shown for a feature this license does not include. The feature stays visible. */
export function LockedFeature({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="card lock-note" role="note">
      <span className="lock-badge" aria-hidden="true">🔒</span>
      <div>
        <strong>{name} is locked on this license</strong>
        <p>{detail}</p>
      </div>
    </div>
  )
}

export function AcoPage({ unlocked, advanced }: { unlocked: boolean; advanced: boolean }) {
  const [step, setStep] = useState(-1)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [profiles, setProfiles] = useState<PublicProfile[]>([])
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState("")
  const [toolsOpen, setToolsOpen] = useState(advanced)

  useEffect(() => {
    if (!unlocked) return
    void Promise.all([unwrap(window.aio.profiles.list()), unwrap(window.aio.accounts.list())])
      .then(([nextProfiles, nextAccounts]) => {
        setProfiles(nextProfiles)
        setAccounts(nextAccounts)
      })
      .catch(() => undefined)
  }, [unlocked])

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
  const storeAccounts = accounts.filter((account) => account.store === draft.store)
  const stepError = (index: number): string => {
    if (index === 0 && !draft.name.trim()) return "Type the client's name."
    if (index === 1 && !draft.sku.trim()) return "Paste the product link or SKU."
    if (index === 1 && !(Number(draft.quantity) >= 1)) return "Quantity is at least 1."
    if (index === 2 && !draft.profileId) return "Pick the shipping profile for this client."
    return ""
  }

  function next() {
    const problem = stepError(step)
    setError(problem)
    if (!problem) setStep((value) => Math.min(STEPS.length - 1, value + 1))
  }

  async function finish() {
    setBusy(true)
    setError("")
    try {
      const client = await unwrap(window.aio.clients.save({
        name: draft.name.trim(),
        contact: draft.contact.trim(),
        notes: "",
        fee: Number(draft.fee) || 0,
        feeBasis: "success",
        status: "active",
        webhook: ""
      }))
      await unwrap(window.aio.tasks.save({
        store: draft.store,
        sku: draft.sku.trim(),
        quantity: Math.max(1, Math.round(Number(draft.quantity) || 1)),
        profileId: draft.profileId,
        accountId: draft.accountId,
        proxyGroupId: null,
        confirmPurchase: false,
        kind: "checkout",
        clientId: client.id,
        maxPrice: draft.maxPrice ? Number(draft.maxPrice) : null
      }))
      setDone(`${client.name} is set up. Their checkout task is in Tasks. Arm it there when you are ready.`)
      setDraft(BLANK)
      setStep(-1)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page aco">
      <header className="page-head">
        <div>
          <h1>ACO</h1>
          <p>Run checkouts for your clients. Four quick steps: who it is for, what to buy, where it ships, confirm.</p>
        </div>
      </header>
      {!unlocked ? <LockedFeature name="ACO" detail="Your key is Standard. An ACO key unlocks client checkouts on the next check-in. Everything else keeps working." /> : null}
      {done ? <Banner tone="info">{done}</Banner> : null}
      {error ? <Banner tone="error">{error}</Banner> : null}
      {step < 0 ? (
        <div className={`card aco-start${unlocked ? "" : " locked"}`}>
          <h2>Add your first ACO client</h2>
          <ol className="aco-preview">
            {STEPS.map((label, index) => <li key={label}><span>{index + 1}</span>{label}</li>)}
          </ol>
          <button type="button" className="primary" disabled={!unlocked} onClick={() => { setDone(""); setStep(0) }}>Start</button>
        </div>
      ) : (
        <div className="card aco-flow">
          <ol className="aco-steps" aria-label="ACO steps">
            {STEPS.map((label, index) => (
              <li key={label} aria-current={index === step ? "step" : undefined} className={index < step ? "done" : ""}>
                <span>{index < step ? "✓" : index + 1}</span>{label}
              </li>
            ))}
          </ol>
          {step === 0 ? (
            <div className="form-grid">
              <Field label="Client name"><TextInput autoFocus value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="Alex" /></Field>
              <Field label="Contact" hint="Discord, phone, or email. Optional."><TextInput value={draft.contact} onChange={(event) => set({ contact: event.target.value })} /></Field>
              <Field label="Your fee per success ($)" hint="Optional. Tracked in the client's ledger."><TextInput inputMode="decimal" value={draft.fee} onChange={(event) => set({ fee: event.target.value })} placeholder="0" /></Field>
            </div>
          ) : null}
          {step === 1 ? (
            <div className="form-grid">
              <Field label="Store">
                <Select value={draft.store} onChange={(event) => set({ store: event.target.value as StoreId, accountId: "" })}>
                  {STORE_CATALOG.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                </Select>
              </Field>
              <Field label="Product link or SKU" hint={STORE_CATALOG.find((store) => store.id === draft.store)?.skuHint}><TextInput value={draft.sku} onChange={(event) => set({ sku: event.target.value })} /></Field>
              <Field label="Quantity"><TextInput inputMode="numeric" value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} /></Field>
              <Field label="Max price ($)" hint="Optional. The checkout stops above this."><TextInput inputMode="decimal" value={draft.maxPrice} onChange={(event) => set({ maxPrice: event.target.value })} /></Field>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="form-grid">
              <Field label="Shipping profile" hint={profiles.length ? "Address and card the order uses." : "No profiles yet. Add one in Profiles first."}>
                <Select value={draft.profileId} onChange={(event) => set({ profileId: event.target.value })}>
                  <option value="">Pick a profile</option>
                  {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </Select>
              </Field>
              <Field label="Store account" hint={storeAccounts.length ? "Optional. The login used at checkout." : "Optional. Add one in Accounts for faster checkouts."}>
                <Select value={draft.accountId} onChange={(event) => set({ accountId: event.target.value })}>
                  <option value="">No account (guest)</option>
                  {storeAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
                </Select>
              </Field>
            </div>
          ) : null}
          {step === 3 ? (
            <dl className="aco-summary">
              <dt>Client</dt><dd>{draft.name}{draft.fee ? ` · $${draft.fee} per success` : ""}</dd>
              <dt>Product</dt><dd>{STORE_CATALOG.find((store) => store.id === draft.store)?.name} · {draft.sku} · ×{draft.quantity}{draft.maxPrice ? ` · max $${draft.maxPrice}` : ""}</dd>
              <dt>Ships with</dt><dd>{profiles.find((profile) => profile.id === draft.profileId)?.name ?? "—"}{draft.accountId ? ` · ${accounts.find((account) => account.id === draft.accountId)?.label ?? ""}` : " · guest"}</dd>
            </dl>
          ) : null}
          <div className="actions">
            <button type="button" onClick={() => { setError(""); setStep((value) => value - 1) }}>{step === 0 ? "Cancel" : "Back"}</button>
            {step < STEPS.length - 1
              ? <button type="button" className="primary" onClick={next}>Continue</button>
              : <button type="button" className="primary" disabled={busy} onClick={() => void finish()}>{busy ? "Creating…" : "Create client and task"}</button>}
          </div>
        </div>
      )}
      <details className="advanced" open={toolsOpen} onToggle={(event) => setToolsOpen((event.target as HTMLDetailsElement).open)}>
        <summary>Advanced: clients, ledger, and fees</summary>
        {!toolsOpen ? null : unlocked ? <ClientsPage /> : <p className="muted">Unlocks with an ACO key.</p>}
      </details>
    </section>
  )
}
