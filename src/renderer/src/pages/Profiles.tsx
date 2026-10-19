import { useEffect, useState } from "react"
import { ME_CLIENT_ID, type Client } from "../../../shared/clients"
import type { Address, ProfileInput, PublicProfile } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

function blankAddress(): Address {
  return { firstName: "", lastName: "", line1: "", line2: "", city: "", state: "", zip: "", country: "US" }
}

function blankForm(): ProfileInput & { sameBilling: boolean } {
  const shipping = blankAddress()
  return {
    name: "",
    email: "",
    phone: "",
    shipping,
    billing: shipping,
    cardName: "",
    cardNumber: "",
    expMonth: "",
    expYear: "",
    cvv: "",
    cardAction: "replace",
    clientId: ME_CLIENT_ID,
    sameBilling: true
  }
}

export function ProfilesPage() {
  const [profiles, setProfiles] = useState<PublicProfile[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [form, setForm] = useState<(ProfileInput & { sameBilling: boolean }) | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function reload() {
    const [nextProfiles, nextClients] = await Promise.all([
      unwrap(window.aio.profiles.list()),
      unwrap(window.aio.clients.list())
    ])
    setProfiles(nextProfiles)
    setClients(nextClients)
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!form) return
    setBusy(true)
    setError("")
    try {
      const billing = form.sameBilling ? form.shipping : form.billing
      const cardAction = form.id && !form.cardNumber.trim() && !form.cvv.trim() ? "keep" : "replace"
      await unwrap(window.aio.profiles.save({ ...form, billing, cardAction }))
      setForm(null)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this profile?")) return
    setError("")
    try {
      await unwrap(window.aio.profiles.delete(id))
      await reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Profiles</h1>
          <p>Shipping and billing stay on this PC. The card number and CVV are encrypted and leave the machine only in the retailer payment request.</p>
        </div>
        <button type="button" className="primary" onClick={() => { setForm(blankForm()); setError("") }}>New profile</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {form ? (
        <div className="drawer-scrim" onMouseDown={() => setForm(null)}>
        <form className="drawer form-grid" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}>
          <Field label="Profile name"><TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></Field>
          <Field label="Email"><TextInput type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required /></Field>
          <Field label="Phone"><TextInput value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} required /></Field>
          <Field label="Client">
            <Select value={form.clientId || ME_CLIENT_ID} onChange={(event) => setForm({ ...form, clientId: event.target.value })}>
              {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </Select>
          </Field>
          <h2 className="span-2">Shipping</h2>
          <AddressFields value={form.shipping} onChange={(shipping) => setForm({ ...form, shipping })} />
          <label className="check span-2">
            <input type="checkbox" checked={form.sameBilling} onChange={(event) => setForm({ ...form, sameBilling: event.target.checked })} />
            <span>Billing address matches shipping</span>
          </label>
          {form.sameBilling ? null : (
            <>
              <h2 className="span-2">Billing</h2>
              <AddressFields value={form.billing} onChange={(billing) => setForm({ ...form, billing })} />
            </>
          )}
          <h2 className="span-2">Card</h2>
          <Field label="Name on card"><TextInput value={form.cardName} onChange={(event) => setForm({ ...form, cardName: event.target.value })} placeholder="Defaults to the shipping name" /></Field>
          <Field label="Card number" hint={form.id ? "Leave blank to keep the saved card." : undefined}>
            <TextInput inputMode="numeric" autoComplete="off" value={form.cardNumber} onChange={(event) => setForm({ ...form, cardNumber: event.target.value })} required={!form.id} />
          </Field>
          <Field label="Exp month"><TextInput value={form.expMonth} onChange={(event) => setForm({ ...form, expMonth: event.target.value })} placeholder="MM" required /></Field>
          <Field label="Exp year"><TextInput value={form.expYear} onChange={(event) => setForm({ ...form, expYear: event.target.value })} placeholder="YYYY" required /></Field>
          <Field label="CVV" hint={form.id ? "Leave blank to keep the saved CVV." : undefined}>
            <TextInput inputMode="numeric" autoComplete="off" value={form.cvv} onChange={(event) => setForm({ ...form, cvv: event.target.value })} required={!form.id} />
          </Field>
          <div className="actions span-2">
            <button className="primary" type="submit" disabled={busy}>Save profile</button>
            <button type="button" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
        </div>
      ) : null}
      <div className="table-wrap card manager">
        <table>
          <thead><tr><th>Name</th><th>Client</th><th>Ship to</th><th>Card</th><th></th></tr></thead>
          <tbody>
            {profiles.length === 0 ? <tr><td colSpan={5} className="empty">No profiles yet.</td></tr> : profiles.map((profile) => (
              <tr key={profile.id}>
                <td>{profile.name}</td>
                <td>{clients.find((client) => client.id === (profile.clientId || ME_CLIENT_ID))?.name ?? "Me"}</td>
                <td>{profile.shipping?.city ?? ""}, {profile.shipping?.state ?? ""} {profile.shipping?.zip ?? ""}</td>
                <td>{profile.cardName} · {profile.last4} · {profile.expMonth}/{profile.expYear}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => setForm(fromProfile(profile))}>Edit</button>
                  <button type="button" className="danger" onClick={() => void remove(profile.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AddressFields({ value, onChange }: { value: Address; onChange: (address: Address) => void }) {
  const set = (key: keyof Address) => (event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: event.target.value })
  return (
    <>
      <Field label="First name"><TextInput value={value.firstName} onChange={set("firstName")} required /></Field>
      <Field label="Last name"><TextInput value={value.lastName} onChange={set("lastName")} required /></Field>
      <Field label="Address"><TextInput value={value.line1} onChange={set("line1")} required /></Field>
      <Field label="Apt / suite"><TextInput value={value.line2} onChange={set("line2")} /></Field>
      <Field label="City"><TextInput value={value.city} onChange={set("city")} required /></Field>
      <Field label="State"><TextInput value={value.state} onChange={set("state")} maxLength={2} placeholder="NY" required /></Field>
      <Field label="ZIP"><TextInput value={value.zip} onChange={set("zip")} required /></Field>
    </>
  )
}

function fromProfile(profile: PublicProfile): ProfileInput & { sameBilling: boolean } {
  const sameBilling = JSON.stringify(profile.shipping) === JSON.stringify(profile.billing)
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    shipping: profile.shipping ?? blankAddress(),
    billing: profile.billing ?? profile.shipping ?? blankAddress(),
    cardName: profile.cardName,
    cardNumber: "",
    expMonth: profile.expMonth,
    expYear: profile.expYear,
    cvv: "",
    cardAction: "keep",
    clientId: profile.clientId || ME_CLIENT_ID,
    sameBilling
  }
}
