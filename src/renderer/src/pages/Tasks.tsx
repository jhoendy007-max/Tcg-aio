import { useEffect, useMemo, useState } from "react"
import { isActiveStatus, type ProxyGroup, type PublicAccount, type PublicProfile, type PublicTask, type StoreHealth, type StoreInfo, type TaskInput } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, formatTime, STATUS_LABEL, unwrap } from "../lib"

const emptyForm = (): TaskInput => ({
  store: "target",
  sku: "",
  quantity: 1,
  profileId: "",
  accountId: "",
  proxyGroupId: null,
  confirmPurchase: false,
  testMode: false
})

export function TasksPage() {
  const [tasks, setTasks] = useState<PublicTask[]>([])
  const [profiles, setProfiles] = useState<PublicProfile[]>([])
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [groups, setGroups] = useState<ProxyGroup[]>([])
  const [stores, setStores] = useState<StoreInfo[]>([])
  const [form, setForm] = useState<TaskInput | null>(null)
  const [healthGroup, setHealthGroup] = useState("")
  const [health, setHealth] = useState<StoreHealth[] | null>(null)
  const [healthError, setHealthError] = useState("")
  const [globalTest, setGlobalTest] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function reload() {
    const [nextTasks, nextProfiles, nextAccounts, nextGroups, nextStores, settings] = await Promise.all([
      unwrap(window.aio.tasks.list()),
      unwrap(window.aio.profiles.list()),
      unwrap(window.aio.accounts.list()),
      unwrap(window.aio.proxies.list()),
      unwrap(window.aio.stores.list()),
      unwrap(window.aio.settings.get())
    ])
    setGlobalTest(settings.settings.testMode)
    setTasks(nextTasks)
    setProfiles(nextProfiles)
    setAccounts(nextAccounts)
    setGroups(nextGroups)
    setStores(nextStores)
    setSelectedId((current) => current ?? nextTasks[0]?.id ?? null)
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
    return window.aio.tasks.onEvent((event) => {
      if (event.type === "delete") {
        setTasks((current) => current.filter((task) => task.id !== event.id))
        setSelectedId((current) => (current === event.id ? null : current))
        return
      }
      setTasks((current) => {
        const index = current.findIndex((task) => task.id === event.task.id)
        if (index < 0) return [event.task, ...current]
        const next = current.slice()
        next[index] = event.task
        return next
      })
    })
  }, [])

  const selected = tasks.find((task) => task.id === selectedId) ?? null
  const storeAccounts = accounts.filter((account) => account.store === form?.store)
  const selectedStore = stores.find((store) => store.id === form?.store)

  const names = useMemo(() => ({
    profile: new Map(profiles.map((profile) => [profile.id, profile.name])),
    account: new Map(accounts.map((account) => [account.id, account.label])),
    group: new Map(groups.map((group) => [group.id, group.name])),
    store: new Map(stores.map((store) => [store.id, store.name]))
  }), [profiles, accounts, groups, stores])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!form) return
    setBusy(true)
    setError("")
    try {
      const saved = await unwrap(window.aio.tasks.save(form))
      setForm(null)
      setSelectedId(saved.id)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function start(id: string) {
    setError("")
    try {
      await unwrap(window.aio.tasks.start(id))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function runTest(id: string) {
    setError("")
    try {
      await unwrap(window.aio.tasks.test(id))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function runHealth() {
    setBusy(true)
    setHealthError("")
    try {
      setHealth(await unwrap(window.aio.health.check(healthGroup || null)))
    } catch (err) {
      setHealthError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function stop(id: string) {
    setError("")
    try {
      await unwrap(window.aio.tasks.stop(id))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this task?")) return
    setError("")
    try {
      await unwrap(window.aio.tasks.delete(id))
      if (selectedId === id) setSelectedId(null)
      await reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Tasks</h1>
          <p>Monitor a drop, add it to cart, and place a ship-to-home order with your own account.</p>
        </div>
        <button type="button" className="primary" onClick={() => { setForm(emptyForm()); setError("") }}>New task</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {globalTest ? <Banner tone="info">Global test mode is on. Every task stops before place order. Nothing is charged.</Banner> : null}
      {form ? (
        <form className="card form-grid" onSubmit={save}>
          <Field label="Store">
            <Select value={form.store} onChange={(event) => setForm({ ...form, store: event.target.value as TaskInput["store"], accountId: "" })}>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>{store.name}{store.implemented ? "" : " (stub)"}</option>
              ))}
            </Select>
          </Field>
          <Field label="Product SKU or URL" hint={selectedStore?.skuHint}>
            <TextInput value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} placeholder="88897904 or a product URL" required />
          </Field>
          <Field label="Quantity">
            <TextInput type="number" min={1} max={12} value={form.quantity} onChange={(event) => setForm({ ...form, quantity: Number(event.target.value) })} required />
          </Field>
          <Field label="Profile">
            <Select value={form.profileId} onChange={(event) => setForm({ ...form, profileId: event.target.value })} required>
              <option value="">Choose a profile</option>
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.last4}</option>)}
            </Select>
          </Field>
          <Field label="Account">
            <Select value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })} required>
              <option value="">Choose an account</option>
              {storeAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
            </Select>
          </Field>
          <Field label="Proxy group">
            <Select value={form.proxyGroupId ?? ""} onChange={(event) => setForm({ ...form, proxyGroupId: event.target.value || null })}>
              <option value="">Direct connection</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.proxies.length})</option>)}
            </Select>
          </Field>
          {selectedStore && !selectedStore.implemented ? (
            <Banner tone="info">{selectedStore.name} is registered, and starting a task records that checkout is not implemented yet.</Banner>
          ) : null}
          <label className="check span-2">
            <input type="checkbox" checked={form.testMode === true} onChange={(event) => setForm({ ...form, testMode: event.target.checked })} />
            <span>Test mode for this task. Runs the real flow and stops before place order, even if the global test setting is off.</span>
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.confirmPurchase} onChange={(event) => setForm({ ...form, confirmPurchase: event.target.checked })} />
            <span>This task may place a real shipping order and charge the saved card when the item is in stock. Ignored while test mode is on.</span>
          </label>
          <div className="actions span-2">
            <button className="primary" type="submit" disabled={busy}>{form.id ? "Save task" : "Create task"}</button>
            <button type="button" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      ) : null}
      <div className="card">
        <div className="log-head">
          <h2>Store health check</h2>
          <span>Read-only monitor. No cart or checkout.</span>
        </div>
        <div className="actions">
          <Select value={healthGroup} onChange={(event) => setHealthGroup(event.target.value)}>
            <option value="">Direct connection</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.proxies.length})</option>)}
          </Select>
          <button type="button" onClick={() => void runHealth()} disabled={busy}>Run health check</button>
        </div>
        {healthError ? <Banner tone="error">{healthError}</Banner> : null}
        {health ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Store</th><th>Proxy</th><th>Status</th><th>Result</th></tr></thead>
              <tbody>
                {health.map((row) => (
                  <tr key={row.store}>
                    <td>{row.storeName}</td>
                    <td>{row.proxy}</td>
                    <td>{row.status ?? "—"} · {row.ms}ms</td>
                    <td><span className={`pill ${row.verdict === "up" ? "success" : row.verdict === "challenge" ? "paused" : "failed"}`}>{row.verdict}</span> <span className="detail">{row.detail}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      <div className="table-wrap card">
        <table>
          <thead>
            <tr>
              <th>Store</th>
              <th>Product</th>
              <th>Qty</th>
              <th>Profile</th>
              <th>Account</th>
              <th>Proxy</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <tr><td colSpan={8} className="empty">No tasks yet. Create one when the profile and account are saved.</td></tr>
            ) : tasks.map((task) => (
              <tr key={task.id} className={task.id === selectedId ? "selected" : ""} onClick={() => setSelectedId(task.id)}>
                <td>{names.store.get(task.store) ?? task.store}{task.testMode || globalTest ? <span className="pill test">TEST</span> : null}</td>
                <td className="sku">{task.sku}</td>
                <td>{task.quantity}</td>
                <td>{names.profile.get(task.profileId) ?? "Missing"}</td>
                <td>{names.account.get(task.accountId) ?? "Missing"}</td>
                <td>{task.proxyGroupId ? names.group.get(task.proxyGroupId) ?? "Missing" : "Direct"}</td>
                <td>
                  <span className={`pill ${task.status}`}>{STATUS_LABEL[task.status]}</span>
                  {task.detail ? <div className="detail">{task.detail}</div> : null}
                </td>
                <td className="row-actions">
                  {isActiveStatus(task.status) ? (
                    <button type="button" onClick={(event) => { event.stopPropagation(); void stop(task.id) }}>Stop</button>
                  ) : (
                    <button type="button" className="primary" disabled={!task.confirmPurchase && !task.testMode} onClick={(event) => { event.stopPropagation(); void start(task.id) }}>
                      {task.status === "paused" ? "Resume" : "Start"}
                    </button>
                  )}
                  {!isActiveStatus(task.status) ? (
                    <button type="button" onClick={(event) => { event.stopPropagation(); void runTest(task.id) }}>Run test</button>
                  ) : null}
                  <button type="button" onClick={(event) => { event.stopPropagation(); setForm(toInput(task)); setError("") }} disabled={isActiveStatus(task.status)}>Edit</button>
                  <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); void remove(task.id) }} disabled={isActiveStatus(task.status)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card log-card">
        <div className="log-head">
          <h2>Status log</h2>
          <span>{selected ? selected.sku : "Select a task"}</span>
        </div>
        <div className="log" aria-live="polite">
          {selected && selected.logs.length > 0 ? selected.logs.map((line, index) => (
            <div key={`${line.ts}-${index}`} className={`log-line ${line.level}`}>
              <time>{formatTime(line.ts)}</time>
              <span>{line.message}</span>
            </div>
          )) : <div className="empty">The live log for the selected task appears here.</div>}
        </div>
      </div>
    </section>
  )
}

function toInput(task: PublicTask): TaskInput {
  return {
    id: task.id,
    store: task.store,
    sku: task.sku,
    quantity: task.quantity,
    profileId: task.profileId,
    accountId: task.accountId,
    proxyGroupId: task.proxyGroupId,
    confirmPurchase: task.confirmPurchase,
    testMode: task.testMode
  }
}
