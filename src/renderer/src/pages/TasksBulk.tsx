import { useState } from "react"
import type { ProxyGroup, PublicAccount, PublicProfile, PublicTask, StoreId, StoreInfo } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function TasksBulk({ tasks, profiles, accounts, groups, stores, onChanged }: {
  tasks: PublicTask[]
  profiles: PublicProfile[]
  accounts: PublicAccount[]
  groups: ProxyGroup[]
  stores: StoreInfo[]
  onChanged: () => Promise<void> | void
}) {
  const [store, setStore] = useState<StoreId>("target")
  const [text, setText] = useState("")
  const [quantity, setQuantity] = useState(1)
  const [profileId, setProfileId] = useState("")
  const [accountId, setAccountId] = useState("")
  const [proxyGroupId, setProxyGroupId] = useState("")
  const [group, setGroup] = useState("")
  const [testMode, setTestMode] = useState(false)
  const [confirmPurchase, setConfirmPurchase] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [editQuantity, setEditQuantity] = useState("")
  const [editGroup, setEditGroup] = useState("")
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const storeAccounts = accounts.filter((account) => account.store === store)

  function toggle(id: string) {
    setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const result = await unwrap(window.aio.bulk.create({
        store,
        quantity,
        profileId,
        accountId,
        proxyGroupId: proxyGroupId || null,
        confirmPurchase,
        testMode,
        group,
        text
      }))
      setMessage(`Created ${result.tasks.length} task${result.tasks.length === 1 ? "" : "s"}.${result.errors.length ? ` ${result.errors[0]}` : ""}`)
      setText("")
      await onChanged()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function run(action: () => Promise<void>) {
    if (!picked.length) {
      setError("Choose at least one task.")
      return
    }
    setBusy(true)
    setError("")
    setMessage("")
    try {
      await action()
      await onChanged()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card stack">
      <div>
        <h2>Create many tasks</h2>
        <p className="hint">Paste one SKU or product URL per line, or a CSV with sku, store, quantity, and group. They share the profile, account, and proxy below.</p>
      </div>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      <form className="form-grid" onSubmit={create}>
        <Field label="Store">
          <Select value={store} onChange={(event) => { setStore(event.target.value as StoreId); setAccountId("") }}>
            {stores.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </Field>
        <Field label="Quantity"><TextInput type="number" min={1} max={12} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} required /></Field>
        <Field label="Profile">
          <Select value={profileId} onChange={(event) => setProfileId(event.target.value)} required>
            <option value="">Choose a profile</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </Select>
        </Field>
        <Field label="Account">
          <Select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
            <option value="">Choose an account</option>
            {storeAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
          </Select>
        </Field>
        <Field label="Proxy group">
          <Select value={proxyGroupId} onChange={(event) => setProxyGroupId(event.target.value)}>
            <option value="">Direct connection</option>
            {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </Field>
        <Field label="Group"><TextInput value={group} onChange={(event) => setGroup(event.target.value)} placeholder="ETB" /></Field>
        <Field className="span-2" label="SKU list or CSV">
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={6} placeholder={"88897904\nhttps://www.walmart.com/ip/123456789\nsku,quantity,group\n94724620,2,ETB"} required />
        </Field>
        <label className="check"><input type="checkbox" checked={testMode} onChange={(event) => setTestMode(event.target.checked)} /><span>Test mode</span></label>
        <label className="check"><input type="checkbox" checked={confirmPurchase} onChange={(event) => setConfirmPurchase(event.target.checked)} /><span>May place a real order</span></label>
        <div className="actions span-2"><button className="primary" type="submit" disabled={busy}>Create tasks</button></div>
      </form>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void run(async () => { const copies = await unwrap(window.aio.bulk.duplicate(picked)); setMessage(`Duplicated ${copies.length}.`); setPicked([]) })}>Duplicate</button>
        <button type="button" className="danger" disabled={busy} onClick={() => void run(async () => { const result = await unwrap(window.aio.bulk.delete(picked)); setMessage(`Deleted ${result.deleted.length}.`); setPicked([]) })}>Delete</button>
        <TextInput value={editQuantity} onChange={(event) => setEditQuantity(event.target.value)} placeholder="Qty" />
        <TextInput value={editGroup} onChange={(event) => setEditGroup(event.target.value)} placeholder="Group" />
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await unwrap(window.aio.bulk.edit({
            ids: picked,
            quantity: editQuantity ? Number(editQuantity) : undefined,
            group: editGroup || undefined
          }))
          setMessage(`Updated ${result.updated.length}.`)
        })}>Apply to selected</button>
      </div>
      <div className="choices">
        {tasks.map((task) => (
          <label key={task.id} className="check">
            <input type="checkbox" checked={picked.includes(task.id)} onChange={() => toggle(task.id)} />
            <span>{task.sku}{task.group ? ` · ${task.group}` : ""}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
