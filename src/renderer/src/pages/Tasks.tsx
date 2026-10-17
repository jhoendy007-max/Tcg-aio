import { useEffect, useMemo, useState } from "react"
import { isActiveStatus, type ProxyGroup, type PublicAccount, type PublicChallenge, type PublicProfile, type PublicTask, type Settings, type StoreHealth, type StoreInfo, type TaskInput, type TaskStatus } from "../../../shared/types"
import { moduleScope, moduleText, resolveModule, sourceLabel } from "../../../shared/module-settings"
import { storeName } from "../../../shared/stores"
import { ProductVisual } from "../components/marks"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { TasksBulk } from "./TasksBulk"
import { errorText, formatTime, STATUS_LABEL, unwrap } from "../lib"

const emptyForm = (): TaskInput => ({
  store: "target",
  sku: "",
  quantity: 1,
  profileId: "",
  accountId: "",
  proxyGroupId: null,
  monitorProxyGroupId: null,
  confirmPurchase: false,
  testMode: false,
  group: "",
  imageUrl: "",
  monitorOnly: false
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
  const [challenge, setChallenge] = useState<PublicChallenge | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [settings, setSettings] = useState<Settings | null>(null)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "">("")
  const [storeFilter, setStoreFilter] = useState("")
  const [grouped, setGrouped] = useState(true)
  const [dragId, setDragId] = useState<string | null>(null)

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
    setSettings(settings.settings)
    setTasks(nextTasks)
    setProfiles(nextProfiles)
    setAccounts(nextAccounts)
    setGroups(nextGroups)
    setStores(nextStores)
    setSelectedId((current) => current ?? nextTasks[0]?.id ?? null)
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
    void unwrap(window.aio.challenge.get()).then(setChallenge).catch(() => undefined)
    const stopTasks = window.aio.tasks.onEvent((event) => {
      if (event.type === "delete") {
        setTasks((current) => current.filter((task) => task.id !== event.id))
        setSelectedId((current) => (current === event.id ? null : current))
        return
      }
      setTasks((current) => {
        const index = current.findIndex((task) => task.id === event.task.id)
        const next = index < 0 ? [event.task, ...current] : current.slice()
        if (index >= 0) next[index] = event.task
        return next.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.createdAt - a.createdAt)
      })
    })
    const stopChallenge = window.aio.challenge.onEvent(setChallenge)
    return () => {
      stopTasks()
      stopChallenge()
    }
  }, [])

  useEffect(() => {
    if (!challenge) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [challenge])

  const taskView = settings?.taskView ?? "detailed"
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return tasks.filter((task) => {
      if (statusFilter && task.status !== statusFilter) return false
      if (storeFilter && task.store !== storeFilter) return false
      if (!needle) return true
      const hay = [task.sku, task.group, task.detail, storeName(task.store), STATUS_LABEL[task.status]].join(" ").toLowerCase()
      return hay.includes(needle)
    })
  }, [tasks, query, statusFilter, storeFilter])
  const sections = useMemo(() => {
    if (!grouped) return [{ label: "", rows: filtered }]
    const buckets = new Map<string, PublicTask[]>()
    for (const task of filtered) {
      const label = task.group?.trim() || "Ungrouped"
      const rows = buckets.get(label) ?? []
      rows.push(task)
      buckets.set(label, rows)
    }
    return [...buckets.entries()].map(([label, rows]) => ({ label, rows }))
  }, [filtered, grouped])

  async function commitOrder(ids: string[]) {
    setError("")
    try {
      setTasks(await unwrap(window.aio.tasks.reorder(ids)))
    } catch (err) {
      setError(errorText(err))
    }
  }

  function place(fromId: string, toId: string, after: boolean) {
    if (fromId === toId) return
    const next = tasks.map((task) => task.id).filter((id) => id !== fromId)
    let index = next.indexOf(toId)
    if (index < 0) return
    if (after) index += 1
    next.splice(index, 0, fromId)
    void commitOrder(next)
  }

  function moveVisible(id: string, delta: number) {
    const visible = filtered.map((task) => task.id)
    const index = visible.indexOf(id)
    const target = visible[index + delta]
    if (!target) return
    place(id, target, delta > 0)
  }

  async function setView(taskView: Settings["taskView"]) {
    if (!settings) return
    const next = { ...settings, taskView }
    setSettings(next)
    try {
      const saved = await unwrap(window.aio.settings.save(next))
      setSettings(saved.settings)
      window.dispatchEvent(new CustomEvent("tcgaio-settings", { detail: saved.settings }))
    } catch (err) {
      setError(errorText(err))
    }
  }

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
        <button type="button" className="primary" onClick={() => { setForm(freshTask(settings)); setError("") }}>New task</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {globalTest ? <Banner tone="info">Global test mode is on. Every task stops before place order. Nothing is charged.</Banner> : null}
      {challenge ? (
        <div className="card">
          <h2>Solve the challenge</h2>
          <p>{challenge.storeName} · {challenge.sku} · {challenge.proxyLabel} · {Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000))}s left</p>
          <p>{challenge.reason}</p>
          <p>A person solves this page. TCGAIO does not send it to a solving service. Open browser uses this PC, the task proxy, and the task cookies. The phone can open the same page on the phone network, and that path only sends back cookies JavaScript can see.</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void unwrap(window.aio.challenge.open()).catch((err) => setError(errorText(err)))}>Open browser</button>
            <button type="button" onClick={() => void unwrap(window.aio.challenge.done()).catch((err) => setError(errorText(err)))}>I solved it</button>
            <button type="button" onClick={() => void unwrap(window.aio.challenge.dismiss()).catch((err) => setError(errorText(err)))}>Dismiss</button>
          </div>
        </div>
      ) : null}
      {form ? (
        <form className="card form-grid" onSubmit={save}>
          <Field label="Store">
            <Select value={form.store} onChange={(event) => {
              const store = event.target.value as TaskInput["store"]
              const testMode = form.id ? form.testMode : settings ? resolveModule(store, moduleScope(settings)).testMode.value : false
              setForm({ ...form, store, accountId: "", testMode })
            }}>
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
          <Field label="Group" hint="Optional. A drop can start every task with this label.">
            <TextInput value={form.group ?? ""} onChange={(event) => setForm({ ...form, group: event.target.value })} placeholder="ETB" />
          </Field>
          <Field className="span-2" label="Product image URL" hint="Optional https link. A running monitor fills a blank field from the product data it already downloaded.">
            <TextInput value={form.imageUrl ?? ""} onChange={(event) => setForm({ ...form, imageUrl: event.target.value })} placeholder="https://" inputMode="url" />
          </Field>
          <Field label="Monitor proxy group" hint="Stock checks use this pool. Leave it blank to use the checkout proxy group.">
            <Select value={form.monitorProxyGroupId ?? ""} onChange={(event) => setForm({ ...form, monitorProxyGroupId: event.target.value || null })}>
              <option value="">Same as checkout</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </Select>
          </Field>
          <Field label="Checkout proxy group">
            <Select value={form.proxyGroupId ?? ""} onChange={(event) => setForm({ ...form, proxyGroupId: event.target.value || null })}>
              <option value="">Direct connection</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.proxies.length})</option>)}
            </Select>
          </Field>
          {selectedStore && !selectedStore.implemented ? (
            <Banner tone="info">{selectedStore.name} is registered, and starting a task records that checkout is not implemented yet.</Banner>
          ) : null}
          <label className="check span-2">
            <input type="checkbox" checked={form.monitorOnly === true} onChange={(event) => setForm({ ...form, monitorOnly: event.target.checked })} />
            <span>Monitor only. Watch stock and send alerts. This task never adds the item to a cart.</span>
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.testMode === true} onChange={(event) => setForm({ ...form, testMode: event.target.checked })} />
            <span>Test mode for this task. Runs the real flow and stops before place order, even if the global test setting is off.</span>
          </label>
          {settings ? <TaskOverrides form={form} settings={settings} onChange={setForm} /> : null}
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
              <thead><tr><th>Store</th><th>Proxy</th><th>Status</th><th>Block rate</th><th>Result</th></tr></thead>
              <tbody>
                {health.map((row) => (
                  <tr key={row.store}>
                    <td>{row.storeName}</td>
                    <td>{row.proxy}</td>
                    <td>{row.status ?? "—"} · {row.ms}ms</td>
                    <td>{row.blockSamples ? `${row.blockCount}/${row.blockSamples} · ${Math.round(row.blockRate * 100)}%` : "—"}</td>
                    <td><span className={`pill ${row.verdict === "up" ? "success" : row.verdict === "challenge" ? "paused" : "failed"}`}>{row.verdict}</span> <span className="detail">{row.detail}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      <TasksBulk tasks={tasks} profiles={profiles} accounts={accounts} groups={groups} stores={stores} onChanged={() => reload()} />
      <div className="card toolbar">
        <Field label="Search">
          <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SKU, store, or group" aria-label="Search tasks" />
        </Field>
        <Field label="Status">
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "")} aria-label="Filter by status">
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
          </Select>
        </Field>
        <Field label="Store">
          <Select value={storeFilter} onChange={(event) => setStoreFilter(event.target.value)} aria-label="Filter by store">
            <option value="">All stores</option>
            {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
          </Select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={grouped} onChange={(event) => setGrouped(event.target.checked)} />
          <span>Group by drop</span>
        </label>
        <div className="actions">
          <button type="button" aria-pressed={taskView === "compact"} onClick={() => void setView("compact")}>Compact</button>
          <button type="button" aria-pressed={taskView === "detailed"} onClick={() => void setView("detailed")}>Detailed</button>
        </div>
      </div>
      <div className="table-wrap card">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Product</th>
              {taskView === "detailed" ? <th>Qty</th> : null}
              {taskView === "detailed" ? <th>Profile</th> : null}
              {taskView === "detailed" ? <th>Account</th> : null}
              {taskView === "detailed" ? <th>Proxy</th> : null}
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <tr><td colSpan={taskView === "detailed" ? 8 : 4} className="empty">No tasks yet. Create one when the profile and account are saved.</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={taskView === "detailed" ? 8 : 4} className="empty">No tasks match this search.</td></tr>
            ) : sections.map((section) => (
              <SectionRows
                key={section.label || "all"}
                section={section}
                grouped={grouped}
                taskView={taskView}
                selectedId={selectedId}
                globalTest={globalTest}
                dragId={dragId}
                names={names}
                onSelect={setSelectedId}
                onDrag={setDragId}
                onDrop={(target) => { if (dragId) place(dragId, target, false); setDragId(null) }}
                onMove={moveVisible}
                onStart={start}
                onStop={stop}
                onTest={runTest}
                onEdit={(task) => { setForm(toInput(task)); setError("") }}
                onDelete={remove}
              />
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

function SectionRows({ section, grouped, taskView, selectedId, globalTest, dragId, names, onSelect, onDrag, onDrop, onMove, onStart, onStop, onTest, onEdit, onDelete }: {
  section: { label: string; rows: PublicTask[] }
  grouped: boolean
  taskView: "compact" | "detailed"
  selectedId: string | null
  globalTest: boolean
  dragId: string | null
  names: { profile: Map<string, string>; account: Map<string, string>; group: Map<string, string> }
  onSelect: (id: string) => void
  onDrag: (id: string | null) => void
  onDrop: (id: string) => void
  onMove: (id: string, delta: number) => void
  onStart: (id: string) => void
  onStop: (id: string) => void
  onTest: (id: string) => void
  onEdit: (task: PublicTask) => void
  onDelete: (id: string) => void
}) {
  const cols = taskView === "detailed" ? 8 : 4
  return (
    <>
      {grouped ? <tr className="group-row"><td colSpan={cols}>{section.label}</td></tr> : null}
      {section.rows.map((task) => (
        <tr
          key={task.id}
          className={`${task.id === selectedId ? "selected" : ""} ${dragId === task.id ? "dragging" : ""}`.trim()}
          onClick={() => onSelect(task.id)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); onDrop(task.id) }}
        >
          <td className="row-actions">
            <button type="button" className="drag-handle" draggable aria-label={`Drag ${task.sku}`} onDragStart={(event) => { event.dataTransfer.setData("text/plain", task.id); event.dataTransfer.effectAllowed = "move"; onDrag(task.id) }} onDragEnd={() => onDrag(null)}>Move</button>
            <button type="button" aria-label={`Move ${task.sku} up`} onClick={(event) => { event.stopPropagation(); onMove(task.id, -1) }}>Up</button>
            <button type="button" aria-label={`Move ${task.sku} down`} onClick={(event) => { event.stopPropagation(); onMove(task.id, 1) }}>Down</button>
          </td>
          <td>
            <div className="product-cell">
              <ProductVisual store={task.store} name={storeName(task.store)} sku={task.sku} imageUrl={task.imageUrl} />
              <div>
                <div>{storeName(task.store)}{task.monitorOnly ? <span className="pill">MONITOR</span> : null}{task.testMode || globalTest ? <span className="pill test">TEST</span> : null}</div>
                <div className="sku">{task.sku}</div>
                {typeof task.monitorMs === "number" ? <div className="detail">{task.monitorMs} ms last read{typeof task.detectToCartMs === "number" ? ` · ${task.detectToCartMs} ms to cart` : ""}</div> : null}
              </div>
            </div>
          </td>
          {taskView === "detailed" ? <td>{task.quantity}</td> : null}
          {taskView === "detailed" ? <td>{names.profile.get(task.profileId) ?? "Missing"}</td> : null}
          {taskView === "detailed" ? <td>{names.account.get(task.accountId) ?? "Missing"}</td> : null}
          {taskView === "detailed" ? <td>{task.proxyGroupId ? names.group.get(task.proxyGroupId) ?? "Missing" : "Direct"}</td> : null}
          <td>
            <span className={`pill ${task.status}`}>{STATUS_LABEL[task.status]}</span>
            {task.detail ? <div className="detail">{task.detail}</div> : null}
          </td>
          <td className="row-actions">
            {isActiveStatus(task.status) ? (
              <button type="button" onClick={(event) => { event.stopPropagation(); void onStop(task.id) }}>Stop</button>
            ) : (
              <button type="button" className="primary" disabled={!task.confirmPurchase && !task.testMode && !task.monitorOnly && !globalTest} onClick={(event) => { event.stopPropagation(); void onStart(task.id) }}>
                {task.status === "paused" ? "Resume" : "Start"}
              </button>
            )}
            {!isActiveStatus(task.status) ? (
              <button type="button" onClick={(event) => { event.stopPropagation(); void onTest(task.id) }}>Run test</button>
            ) : null}
            <button type="button" onClick={(event) => { event.stopPropagation(); onEdit(task) }} disabled={isActiveStatus(task.status)}>Edit</button>
            <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); void onDelete(task.id) }} disabled={isActiveStatus(task.status)}>Delete</button>
          </td>
        </tr>
      ))}
    </>
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
    monitorProxyGroupId: task.monitorProxyGroupId,
    confirmPurchase: task.confirmPurchase,
    testMode: task.testMode,
    group: task.group ?? "",
    imageUrl: task.imageUrl ?? "",
    monitorOnly: task.monitorOnly === true,
    overrides: task.overrides
  }
}

function freshTask(settings: Settings | null): TaskInput {
  const form = emptyForm()
  if (!settings) return form
  return { ...form, testMode: resolveModule(form.store, moduleScope(settings)).testMode.value }
}

function TaskOverrides({ form, settings, onChange }: { form: TaskInput; settings: Settings; onChange: (next: TaskInput) => void }) {
  const lang = settings.language === "es" ? "es" : "en"
  const resolved = resolveModule(form.store, moduleScope(settings), form.overrides)
  function setNumber(key: "monitorDelayMs" | "retryDelayMs" | "maxRetries" | "blockBackoffMs", raw: string) {
    const overrides = { ...form.overrides }
    if (!raw.trim()) delete overrides[key]
    else overrides[key] = Math.round(Number(raw))
    onChange({ ...form, overrides })
  }
  return (
    <div className="span-2">
      <h2>{moduleText(lang, "overrides")}</h2>
      <p>{moduleText(lang, "overrideHint")} {moduleText(lang, "monitorDelayMs")}: {resolved.monitorDelayMs.value} ms · {sourceLabel(lang, resolved.monitorDelayMs.source)}. {moduleText(lang, "maxRetries")}: {resolved.maxRetries.value} · {sourceLabel(lang, resolved.maxRetries.source)}.</p>
      <div className="form-grid">
        <Field label={moduleText(lang, "monitorDelayMs")}>
          <TextInput value={form.overrides?.monitorDelayMs ?? ""} placeholder={String(resolved.monitorDelayMs.value)} onChange={(event) => setNumber("monitorDelayMs", event.target.value)} />
        </Field>
        <Field label={moduleText(lang, "retryDelayMs")}>
          <TextInput value={form.overrides?.retryDelayMs ?? ""} placeholder={String(resolved.retryDelayMs.value)} onChange={(event) => setNumber("retryDelayMs", event.target.value)} />
        </Field>
        <Field label={moduleText(lang, "maxRetries")}>
          <TextInput value={form.overrides?.maxRetries ?? ""} placeholder={String(resolved.maxRetries.value)} onChange={(event) => setNumber("maxRetries", event.target.value)} />
        </Field>
        <Field label={moduleText(lang, "blockBackoffMs")}>
          <TextInput value={form.overrides?.blockBackoffMs ?? ""} placeholder={String(resolved.blockBackoffMs.value)} onChange={(event) => setNumber("blockBackoffMs", event.target.value)} />
        </Field>
      </div>
    </div>
  )
}
