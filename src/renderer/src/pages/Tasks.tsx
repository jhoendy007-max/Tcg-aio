import { useEffect, useMemo, useState } from "react"
import { issueText, type HealthIssue } from "../../../shared/checkout-health"
import { clientIdOf, clientText, ME_CLIENT_ID, type Client } from "../../../shared/clients"
import { consistencyText, effectiveBinding } from "../../../shared/consistency"
import { deskText } from "../../../shared/desk-ui"
import { dropOpsText } from "../../../shared/drop-ops"
import { fieldMark, prefillRole } from "../../../shared/store-defaults"
import { isActiveStatus, type ProxyGroup, type PublicAccount, type PublicChallenge, type PublicProfile, type PublicTask, type Settings, type StartMode, type StoreHealth, type StoreInfo, type TaskInput, type TaskKind, type TaskStatus } from "../../../shared/types"
import { moduleScope, moduleText, resolveModule, sourceLabel } from "../../../shared/module-settings"
import { taskText } from "../../../shared/task-role"
import { storeName } from "../../../shared/stores"
import { ProductVisual } from "../components/marks"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { TasksBulk } from "./TasksBulk"
import { errorText, formatTime, STATUS_LABEL, statusLabel, unwrap } from "../lib"
import { QuickSetup } from "./QuickSetup"

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
  monitorOnly: false,
  kind: "checkout",
  keywords: "",
  priceCap: null,
  webhook: "",
  activeHours: "",
  linkedCheckoutIds: [],
  checkoutDelayMs: null,
  maxPrice: null,
  startMode: "builtin",
  jitterPct: null,
  clientId: ME_CLIENT_ID
})

export function TasksPage({ lockedKind = "" }: { lockedKind?: TaskKind | "" }) {
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
  const [cloneIds, setCloneIds] = useState<string[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [challenge, setChallenge] = useState<PublicChallenge | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [settings, setSettings] = useState<Settings | null>(null)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "">("")
  const [storeFilter, setStoreFilter] = useState("")
  const [kindFilter, setKindFilter] = useState<TaskKind | "">(lockedKind)
  const [folder, setFolder] = useState("")
  const [picked, setPicked] = useState<string[]>([])
  const [showQuick, setShowQuick] = useState(false)
  const [clientFilter, setClientFilter] = useState("")
  const [clients, setClients] = useState<Client[]>([])
  const [grouped, setGrouped] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [checkoutIssues, setCheckoutIssues] = useState<Map<string, HealthIssue[]>>(new Map())

  async function reload() {
    const [nextTasks, nextProfiles, nextAccounts, nextGroups, nextStores, nextClients, settings, healthRows] = await Promise.all([
      unwrap(window.aio.tasks.list()),
      unwrap(window.aio.profiles.list()),
      unwrap(window.aio.accounts.list()),
      unwrap(window.aio.proxies.list()),
      unwrap(window.aio.stores.list()),
      unwrap(window.aio.clients.list()),
      unwrap(window.aio.settings.get()),
      unwrap(window.aio.checkoutHealth.tasks())
    ])
    setGlobalTest(settings.settings.testMode)
    setSettings(settings.settings)
    setTasks(nextTasks)
    setProfiles(nextProfiles)
    setAccounts(nextAccounts)
    setGroups(nextGroups)
    setStores(nextStores)
    setClients(nextClients)
    setCheckoutIssues(new Map(healthRows.map((row) => [row.taskId, row.issues])))
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
      void unwrap(window.aio.checkoutHealth.tasks()).then((rows) => {
        setCheckoutIssues(new Map(rows.map((row) => [row.taskId, row.issues])))
      }).catch(() => undefined)
    })
    const stopChallenge = window.aio.challenge.onEvent(setChallenge)
    return () => {
      stopTasks()
      stopChallenge()
    }
  }, [])

  useEffect(() => { setKindFilter(lockedKind) }, [lockedKind])

  useEffect(() => {
    if (!challenge) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [challenge])

  const taskView = settings?.taskView ?? "detailed"
  const lang = settings?.language === "es" ? "es" : "en"
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return tasks.filter((task) => {
      if (statusFilter && task.status !== statusFilter) return false
      if (storeFilter && task.store !== storeFilter) return false
      if (kindFilter === "monitor" && task.kind !== "monitor") return false
      if (kindFilter === "checkout" && task.kind === "monitor") return false
      if (clientFilter && clientIdOf(task.clientId) !== clientFilter) return false
      if (!needle) return true
      const hay = [task.sku, task.group, task.detail, storeName(task.store), statusLabel(task.status, lang)].join(" ").toLowerCase()
      return hay.includes(needle)
    })
  }, [tasks, query, statusFilter, storeFilter, kindFilter, clientFilter, lang])
  const folderName = (task: PublicTask) => task.group?.trim() || storeName(task.store)
  const folders = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of filtered) counts.set(folderName(task), (counts.get(folderName(task)) ?? 0) + 1)
    return [...counts.entries()]
  }, [filtered])
  const folderStats = useMemo(() => {
    const stats = new Map<string, { carts: number; wins: number; fails: number; live: number }>()
    for (const task of filtered) {
      const row = stats.get(folderName(task)) ?? { carts: 0, wins: 0, fails: 0, live: 0 }
      if (task.status === "adding_to_cart" || task.status === "checking_out") row.carts += 1
      if (task.status === "success" || task.status === "tested") row.wins += 1
      if (task.status === "failed") row.fails += 1
      if (isActiveStatus(task.status)) row.live += 1
      stats.set(folderName(task), row)
    }
    return stats
  }, [filtered])
  const listed = useMemo(() => (folder ? filtered.filter((task) => folderName(task) === folder) : filtered), [filtered, folder])
  const sections = useMemo(() => {
    if (!grouped) return [{ label: "", rows: listed }]
    const buckets = new Map<string, PublicTask[]>()
    for (const task of listed) {
      const label = task.group?.trim() || "Ungrouped"
      const rows = buckets.get(label) ?? []
      rows.push(task)
      buckets.set(label, rows)
    }
    return [...buckets.entries()].map(([label, rows]) => ({ label, rows }))
  }, [listed, grouped])

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

  const names = useMemo(() => ({
    profile: new Map(profiles.map((profile) => [profile.id, profile.name])),
    account: new Map(accounts.map((account) => [account.id, account.label])),
    group: new Map(groups.map((group) => [group.id, group.name])),
    store: new Map(stores.map((store) => [store.id, store.name])),
    client: new Map(clients.map((client) => [client.id, client.name]))
  }), [profiles, accounts, groups, stores, clients])

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

  function togglePick(id: string) {
    setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  async function bulkRun(action: "start" | "stop" | "delete") {
    const ids = picked.length ? picked : listed.map((task) => task.id)
    if (!ids.length) return
    if (action === "delete" && !window.confirm(deskText(lang, "confirmDelete"))) return
    setError("")
    try {
      if (action === "delete") {
        await unwrap(window.aio.bulk.delete(ids))
        setPicked([])
        await reload()
        return
      }
      for (const id of ids) {
        if (action === "start") await unwrap(window.aio.tasks.start(id))
        else await unwrap(window.aio.tasks.stop(id))
      }
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function remove(id: string) {
    if (!window.confirm(deskText(lang, "confirmDelete"))) return
    setError("")
    try {
      await unwrap(window.aio.tasks.delete(id))
      if (selectedId === id) setSelectedId(null)
      await reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const allPicked = listed.length > 0 && listed.every((task) => picked.includes(task.id))
  const role = kindFilter === "monitor" ? "monitor" : kindFilter === "checkout" ? "checkout" : ""

  return (
    <section className="page">
      <h1 className="sr-only">{deskText(lang, "navTasks")}</h1>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {showQuick && settings ? (
        <QuickSetup
          lang={lang}
          stores={stores}
          profiles={profiles}
          accounts={accounts}
          clients={clients}
          groups={groups}
          tasks={tasks}
          globalTest={globalTest}
          warmOnStart={settings.warmOnStart}
          onCreated={reload}
          onWarm={async (enabled) => {
            const saved = await unwrap(window.aio.settings.save({ ...settings, warmOnStart: enabled }))
            setSettings(saved.settings)
            window.dispatchEvent(new CustomEvent("tcgaio-settings", { detail: saved.settings }))
          }}
        />
      ) : null}
      {globalTest ? <Banner tone="info">Global test mode is on. Every task stops before place order. Nothing is charged.</Banner> : null}
      {challenge ? (
        <div className="card">
          <h2>Solve the challenge</h2>
          <p>{challenge.storeName} · {challenge.sku} · {challenge.proxyLabel} · {Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000))}s left</p>
          <p>{challenge.reason}</p>
          <p>A person solves this page. Zzz AIO does not send it to a solving service. Open browser uses this PC, the task proxy, and the task cookies. The phone can open the same page on the phone network, and that path only sends back cookies JavaScript can see.</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void unwrap(window.aio.challenge.open()).catch((err) => setError(errorText(err)))}>Open browser</button>
            <button type="button" onClick={() => void unwrap(window.aio.challenge.done()).catch((err) => setError(errorText(err)))}>I solved it</button>
            <button type="button" onClick={() => void unwrap(window.aio.challenge.dismiss()).catch((err) => setError(errorText(err)))}>Dismiss</button>
          </div>
        </div>
      ) : null}
      {form ? (
        <div className="drawer-scrim" onMouseDown={() => setForm(null)}>
          <div className="drawer" onMouseDown={(event) => event.stopPropagation()}>
            <TaskEditor
              form={form}
              tasks={tasks}
              settings={settings}
              stores={stores}
              profiles={profiles}
              accounts={storeAccounts}
              clients={clients}
              groups={groups}
              busy={busy}
              lang={lang}
              live={Boolean(form.id && isActiveStatus(tasks.find((task) => task.id === form.id)?.status ?? "idle"))}
              onChange={setForm}
              onCancel={() => setForm(null)}
              onSubmit={save}
            />
          </div>
        </div>
      ) : null}
      <details className="advanced">
        <summary>{deskText(lang, "checkStores")}</summary>
      <div className="card">
        <div className="log-head">
          <h2>{taskText(lang, "healthTitle")}</h2>
          <span>{taskText(lang, "healthHint")}</span>
        </div>
        <div className="actions">
          <Select value={healthGroup} onChange={(event) => setHealthGroup(event.target.value)}>
            <option value="">{taskText(lang, "direct")}</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.proxies?.length ?? 0})</option>)}
          </Select>
          <button type="button" onClick={() => void runHealth()} disabled={busy}>{taskText(lang, "healthRun")}</button>
        </div>
        {healthError ? <Banner tone="error">{healthError}</Banner> : null}
        {health ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{taskText(lang, "healthStore")}</th><th>{taskText(lang, "healthProxy")}</th><th>{taskText(lang, "healthStatus")}</th><th>{taskText(lang, "healthBlock")}</th><th>{taskText(lang, "healthResult")}</th></tr></thead>
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
      </details>
      <details className="advanced">
        <summary>{deskText(lang, "createMany")}</summary>
        <TasksBulk tasks={tasks} profiles={profiles} accounts={accounts} groups={groups} stores={stores} lang={lang} onChanged={() => reload()} />
      </details>
      <details className="advanced">
      <summary>Filters &amp; view</summary>
      <div className="card toolbar">
        <Field label="Search">
          <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SKU, store, or group" aria-label="Search tasks" />
        </Field>
        <Field label="Status">
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "")} aria-label="Filter by status">
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((status) => <option key={status} value={status}>{statusLabel(status, lang)}</option>)}
          </Select>
        </Field>
        <Field label="Store">
          <Select value={storeFilter} onChange={(event) => setStoreFilter(event.target.value)} aria-label="Filter by store">
            <option value="">All stores</option>
            {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
          </Select>
        </Field>
        <Field label={clientText(lang, "filter")}>
          <Select value={clientFilter} onChange={(event) => setClientFilter(event.target.value)} aria-label={clientText(lang, "filter")}>
            <option value="">{clientText(lang, "allClients")}</option>
            {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
          </Select>
        </Field>
        <Field label={taskText(lang, "kind")}>
          <Select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as TaskKind | "")} aria-label={taskText(lang, "kind")}>
            <option value="">All</option>
            <option value="monitor">{taskText(lang, "monitor")}</option>
            <option value="checkout">{taskText(lang, "checkout")}</option>
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
      </details>
      <div className="task-desk">
        <aside className="folders">
          <div className="groups-head">
            <div><h2>Task Groups</h2><span className="hint">{folders.length + 1} total</span></div>
            <button type="button" className="plus-btn" aria-label={deskText(lang, "newTask")} title={deskText(lang, "newTask")} onClick={() => { setForm(freshTask(settings, kindFilter === "monitor" ? "monitor" : "checkout")); setError("") }}>+</button>
          </div>
          {([["", filtered.length], ...folders] as Array<[string, number]>).map(([label, count]) => {
            const stat = label ? folderStats.get(label) : [...folderStats.values()].reduce((sum, row) => ({ carts: sum.carts + row.carts, wins: sum.wins + row.wins, fails: sum.fails + row.fails, live: sum.live + row.live }), { carts: 0, wins: 0, fails: 0, live: 0 })
            return (
              <button key={label || "all"} type="button" className="group-card" aria-pressed={folder === label} onClick={() => setFolder(label)}>
                <span className="group-top"><strong>{label || deskText(lang, "allGroups")}</strong><span className="count">{stat?.live ?? 0} / {count}</span></span>
                <span className="group-stats">
                  <span className="gs cart" title="Carts">🛒 {stat?.carts ?? 0}</span>
                  <span className="gs win" title="Checkouts">✓ {stat?.wins ?? 0}</span>
                  <span className="gs fail" title="Declines">✕ {stat?.fails ?? 0}</span>
                </span>
              </button>
            )
          })}
        </aside>
        <div className="group-main">
          <div className="group-head">
            <div className="group-title">
              <span className="store-badge">{(folder || "A").slice(0, 1).toUpperCase()}</span>
              <div><strong>{folder || deskText(lang, "allGroups")}</strong><span className="hint">{listed.length} Tasks</span></div>
              <button type="button" className="plus-btn" aria-label={deskText(lang, "newTask")} onClick={() => { setForm(freshTask(settings, kindFilter === "monitor" ? "monitor" : "checkout")); setError("") }}>+</button>
              <div className="pill-tabs" role="tablist">
                {(["", "monitor", "checkout"] as const).map((kind) => (
                  <a key={kind || "all"} href={kind ? `#tasks/${kind}` : "#tasks"} aria-current={role === kind ? "page" : undefined}>{deskText(lang, kind === "" ? "tabAll" : kind === "monitor" ? "tabMonitor" : "tabCheckout")}</a>
                ))}
              </div>
              <TextInput className="group-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search tasks" />
            </div>
            <div className="actions group-actions">
              <button type="button" onClick={() => setShowQuick((open) => !open)}>⚙ {deskText(lang, "quickSetup")}</button>
              <button type="button" className="dark" disabled={picked.length !== 1} onClick={() => {
                const task = tasks.find((item) => item.id === picked[0])
                if (task) { setForm(toInput(task)); setError("") }
              }}>✎ Edit</button>
              <button type="button" className="primary" disabled={!listed.length} onClick={() => void bulkRun("start")}>▶ Start {picked.length ? "Selected" : "All"}</button>
              <button type="button" className="primary" disabled={!listed.length} onClick={() => void bulkRun("stop")}>■ Stop {picked.length ? "Selected" : "All"}</button>
              <button type="button" className="danger solid" disabled={!listed.length} onClick={() => void bulkRun("delete")}>🗑 Delete {picked.length ? "Selected" : "All"}</button>
            </div>
          </div>
      <div className="table-wrap card">
        <table>
          <thead>
            <tr>
              <th><input type="checkbox" aria-label={deskText(lang, "selectAll")} checked={allPicked} onChange={() => {
                const ids = listed.map((task) => task.id)
                setPicked((current) => allPicked ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])])
              }} /></th>
              <th>Item/s</th>
              {taskView === "detailed" ? <th className="col-extra">Qty</th> : null}
              {taskView === "detailed" ? <th className="col-extra">Profile</th> : null}
              {taskView === "detailed" ? <th className="col-extra">Account</th> : null}
              {taskView === "detailed" ? <th className="col-extra">Proxy</th> : null}
              <th>Status</th>
              <th className="th-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <tr><td colSpan={taskView === "detailed" ? 8 : 4} className="empty"><div className="empty-ico">☰</div>{deskText(lang, "emptyTasks")} <button type="button" className="primary" onClick={() => { setForm(freshTask(settings, "checkout")); setError("") }}>{deskText(lang, "emptyNext")}</button></td></tr>
            ) : listed.length === 0 ? (
              <tr><td colSpan={taskView === "detailed" ? 8 : 4} className="empty">No tasks match this search.</td></tr>
            ) : sections.map((section) => (
              <SectionRows
                key={section.label || "all"}
                section={section}
                grouped={grouped}
                taskView={taskView}
                selectedId={selectedId}
                picked={picked}
                globalTest={globalTest}
                dragId={dragId}
                names={names}
                accounts={accounts}
                groups={groups}
                lang={lang}
                checkoutIssues={checkoutIssues}
                onSelect={setSelectedId}
                onToggle={togglePick}
                onDrag={setDragId}
                onDrop={(target) => { if (dragId) place(dragId, target, false); setDragId(null) }}
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
        </div>
      </div>
      {selected ? (
        <div className="card stack">
          <h2>{dropOpsText(lang, "cloneTitle")}</h2>
          <p className="hint">{dropOpsText(lang, "cloneHint")}</p>
          <div className="choices">
            {accounts.filter((account) => account.store === selected.store && clientIdOf(account.clientId) === clientIdOf(selected.clientId)).map((account) => (
              <label key={account.id} className="check">
                <input type="checkbox" checked={cloneIds.includes(account.id)} onChange={() => setCloneIds((current) => current.includes(account.id) ? current.filter((id) => id !== account.id) : [...current, account.id])} />
                <span>{account.label}</span>
              </label>
            ))}
          </div>
          <div className="actions">
            <button type="button" className="primary" disabled={!cloneIds.length} onClick={() => {
              void unwrap(window.aio.bulk.clone(selected.id, cloneIds)).then(async () => {
                setCloneIds([])
                await reload()
              }).catch((err) => setError(errorText(err)))
            }}>{dropOpsText(lang, "cloneButton")}</button>
          </div>
        </div>
      ) : null}
      <div className="card log-card">
        <div className="log-head">
          <h2>Status log</h2>
          <span>{selected ? selected.sku : "Select a task"}</span>
        </div>
        <div className="log" aria-live="polite">
          {selected && (selected.logs ?? []).length > 0 ? (selected.logs ?? []).map((line, index) => (
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

function SectionRows({ section, grouped, taskView, selectedId, picked, globalTest, dragId, names, accounts, groups, lang, checkoutIssues, onSelect, onToggle, onDrag, onDrop, onStart, onStop, onTest, onEdit, onDelete }: {
  section: { label: string; rows: PublicTask[] }
  grouped: boolean
  taskView: "compact" | "detailed"
  selectedId: string | null
  picked: string[]
  globalTest: boolean
  dragId: string | null
  names: { profile: Map<string, string>; account: Map<string, string>; group: Map<string, string>; client: Map<string, string> }
  accounts: PublicAccount[]
  groups: ProxyGroup[]
  lang: "en" | "es"
  checkoutIssues: Map<string, HealthIssue[]>
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onDrag: (id: string | null) => void
  onDrop: (id: string) => void
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
          <td>
            <input type="checkbox" aria-label={task.sku} checked={picked.includes(task.id)} onClick={(event) => event.stopPropagation()} onChange={() => onToggle(task.id)} />
            <button type="button" className="drag-handle" draggable title="Drag to reorder" aria-label={`Drag ${task.sku}`} onDragStart={(event) => { event.dataTransfer.setData("text/plain", task.id); event.dataTransfer.effectAllowed = "move"; onDrag(task.id) }} onDragEnd={() => onDrag(null)}>⋮⋮</button>
          </td>
          
          <td>
            <div className="product-cell">
              <ProductVisual store={task.store} name={storeName(task.store)} sku={task.sku} imageUrl={task.imageUrl} />
              <div>
                <div>{storeName(task.store)}<span className={`pill role ${task.kind === "monitor" ? "role-monitor" : "role-checkout"}`}>{taskText(lang, task.kind === "monitor" ? "roleBadgeMonitor" : "roleBadgeCheckout")}</span>{task.testMode || globalTest ? <span className="pill test">TEST</span> : null}</div>
                <div className="sku">{task.sku}</div>
                {taskView === "compact" ? bindingCell(task, accounts, groups, lang).summary : null}
                <div className="detail">{names.client.get(clientIdOf(task.clientId)) ?? clientText(lang, "me")}</div>
                {typeof task.monitorMs === "number" ? <div className="detail">{task.monitorMs} ms last read{typeof task.detectToCartMs === "number" ? ` · ${task.detectToCartMs} ms to cart` : ""}</div> : null}
              </div>
            </div>
          </td>
          {taskView === "detailed" ? <td className="col-extra">{task.quantity}</td> : null}
          {taskView === "detailed" ? <td className="col-extra">{task.kind === "monitor" ? "—" : names.profile.get(task.profileId) ?? "Missing"}</td> : null}
          {taskView === "detailed" ? <td className="col-extra">{bindingCell(task, accounts, groups, lang).account}</td> : null}
          {taskView === "detailed" ? <td className="col-extra">{bindingCell(task, accounts, groups, lang).proxy}</td> : null}
          <td>
            <span className={`status-text status-${task.status}`}>{statusLabel(task.status, lang)}</span>
            {task.detail ? <div className="detail">{task.detail}</div> : null}
            {(checkoutIssues.get(task.id) ?? []).slice(0, 2).map((item) => (
              <div key={item.code} className="detail">{issueText(lang, item)}</div>
            ))}
          </td>
          <td className="row-actions">
            {isActiveStatus(task.status) ? (
              <button type="button" className="icon-btn" title={deskText(lang, "bulkStop")} aria-label={deskText(lang, "bulkStop")} onClick={(event) => { event.stopPropagation(); void onStop(task.id) }}>■</button>
            ) : (
              <button type="button" className="icon-btn primary" title={deskText(lang, "bulkStart")} aria-label={deskText(lang, "bulkStart")} disabled={!task.confirmPurchase && !task.testMode && task.kind !== "monitor" && !globalTest} onClick={(event) => { event.stopPropagation(); void onStart(task.id) }}>▶</button>
            )}
            {!isActiveStatus(task.status) ? (
              <button type="button" className="icon-btn" title="Test" aria-label="Test" onClick={(event) => { event.stopPropagation(); void onTest(task.id) }}>◎</button>
            ) : null}
            <button type="button" className="icon-btn" title={deskText(lang, "editSelected")} aria-label={deskText(lang, "editSelected")} onClick={(event) => { event.stopPropagation(); onEdit(task) }}>✎</button>
            <button type="button" className="icon-btn danger" title={deskText(lang, "bulkDelete")} aria-label={deskText(lang, "bulkDelete")} onClick={(event) => { event.stopPropagation(); void onDelete(task.id) }} disabled={isActiveStatus(task.status)}>✕</button>
          </td>
        </tr>
      ))}
    </>
  )
}

function bindingCell(task: PublicTask, accounts: PublicAccount[], groups: ProxyGroup[], lang: "en" | "es") {
  const account = accounts.find((item) => item.id === task.accountId) ?? null
  const binding = effectiveBinding({
    accountId: task.accountId,
    proxyGroupId: task.proxyGroupId,
    monitorProxyGroupId: task.monitorProxyGroupId,
    account,
    groups
  })
  const accountLabel = binding.accountSource === "none"
    ? consistencyText(lang, "fromNone")
    : binding.accountLabel || "Missing"
  const proxyLabel = binding.proxyLabel || consistencyText(lang, "fromDirect")
  const proxySource = binding.proxySource === "account" ? "fromAccount" : binding.proxySource === "task" ? "fromTask" : "fromDirect"
  const accountSource = binding.accountSource === "task" ? "fromAccount" : "fromNone"
  const profileSource = binding.profileSource === "account" ? "fromAccount" : "fromNone"
  const profileLabel = binding.profileLabel || consistencyText(lang, "fromNone")
  return {
    summary: (
      <>
        <div className="detail">{taskText(lang, "account")}: {accountLabel} · {consistencyText(lang, accountSource)}</div>
        <div className="detail">{consistencyText(lang, "profile")}: {profileLabel} · {consistencyText(lang, profileSource)}</div>
        <div className="detail">{consistencyText(lang, "stickyProxy")}: {proxyLabel} · {consistencyText(lang, proxySource)}</div>
      </>
    ),
    account: (
      <>
        <div>{accountLabel}</div>
        <div className="detail">{consistencyText(lang, "profile")}: {profileLabel}</div>
        <div className="detail">{consistencyText(lang, accountSource)} · {consistencyText(lang, profileSource)}</div>
      </>
    ),
    proxy: (
      <>
        <div>{proxyLabel}</div>
        <div className="detail">{consistencyText(lang, proxySource)}</div>
        {binding.warnings.map((warning) => <div key={warning} className="detail">{consistencyText(lang, warning === "sticky" ? "stickyWarning" : "monitorWarning")}</div>)}
      </>
    )
  }
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
    monitorOnly: task.kind === "monitor",
    kind: task.kind === "monitor" ? "monitor" : "checkout",
    keywords: task.keywords ?? "",
    priceCap: task.priceCap ?? null,
    webhook: task.webhook ?? "",
    activeHours: task.activeHours ?? "",
    linkedCheckoutIds: task.linkedCheckoutIds ?? [],
    checkoutDelayMs: task.checkoutDelayMs ?? null,
    maxPrice: task.maxPrice ?? null,
    startMode: task.startMode ?? (task.kind === "monitor" ? "manual" : "builtin"),
    linkedMonitorId: task.linkedMonitorId ?? null,
    jitterPct: task.jitterPct ?? null,
    clientId: task.clientId || ME_CLIENT_ID,
    overrides: task.overrides
  }
}

function TaskEditor({ form, tasks, settings, stores, profiles, accounts, clients, groups, busy, lang, live, onChange, onCancel, onSubmit }: {
  form: TaskInput
  tasks: PublicTask[]
  settings: Settings | null
  stores: StoreInfo[]
  profiles: PublicProfile[]
  accounts: PublicAccount[]
  clients: Client[]
  groups: ProxyGroup[]
  busy: boolean
  lang: "en" | "es"
  live: boolean
  onChange: (next: TaskInput) => void
  onCancel: () => void
  onSubmit: (event: React.FormEvent) => void
}) {
  const monitor = form.kind === "monitor"
  const recommended = settings ? prefillRole(form.store, monitor ? "monitor" : "checkout", settings.storeRoles) : null
  const selectedStore = stores.find((store) => store.id === form.store)
  const accountClient = clientIdOf(accounts.find((account) => account.id === form.accountId)?.clientId)
  const profileChoices = form.accountId ? profiles.filter((profile) => clientIdOf(profile.clientId) === accountClient) : profiles
  const checkouts = tasks.filter((task) => task.kind !== "monitor" && task.id !== form.id)
  const monitors = tasks.filter((task) => task.kind === "monitor" && task.store === form.store && task.id !== form.id)
  const modes: StartMode[] = ["manual", "scheduled", "monitor", "restock", "builtin"]
  const inheritedDelay = settings ? String(resolveModule(form.store, moduleScope(settings), form.overrides).monitorDelayMs.value) : ""
  function chooseKind(kind: TaskKind) {
    if ((form.kind ?? "checkout") === kind) return
    const next = applyRole(form, kind, settings)
    onChange(next)
  }
  return (
    <form className="card form-grid" onSubmit={onSubmit}>
      <div className="span-2 modal-title">
        <h2>{form.id ? "Edit" : "Create"} <u>{monitor ? "Monitor" : "Checkout"}</u> Task</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onCancel}>✕</button>
      </div>
      <div className="span-2 role-switch" role="group" aria-label={taskText(lang, "roleTitle")}>
        <span className="role-title">{taskText(lang, "roleTitle")}</span>
        <div className="choices">
          {(["monitor", "checkout"] as const).map((kind) => (
            <button key={kind} type="button" aria-pressed={(form.kind ?? "checkout") === kind} disabled={live} onClick={() => chooseKind(kind)}>
              {taskText(lang, kind)}
            </button>
          ))}
        </div>
      </div>
      <p className="span-2 hint">{monitor ? taskText(lang, "hintMonitor") : taskText(lang, "hintCheckout")} {live ? taskText(lang, "live") : ""}</p>
      <Field label={taskText(lang, "store")}>
        <Select value={form.store} disabled={live} onChange={(event) => {
          const store = event.target.value as TaskInput["store"]
          onChange(applyRole({ ...form, store, accountId: "" }, form.kind === "monitor" ? "monitor" : "checkout", settings))
        }}>
          {stores.map((store) => (
            <option key={store.id} value={store.id}>{store.name}{store.implemented ? "" : " (stub)"}</option>
          ))}
        </Select>
      </Field>
      <Field label={taskText(lang, "sku")} hint={selectedStore?.skuHint}>
        <TextInput value={form.sku} disabled={live} onChange={(event) => onChange({ ...form, sku: event.target.value })} placeholder="88897904" required={!form.keywords?.trim()} />
      </Field>
      <Field label={taskText(lang, "keywords")} hint={taskText(lang, "inherit")}>
        <TextInput value={form.keywords ?? ""} onChange={(event) => onChange({ ...form, keywords: event.target.value })} />
      </Field>
      <Field label={taskText(lang, "group")}>
        <TextInput value={form.group ?? ""} onChange={(event) => onChange({ ...form, group: event.target.value })} placeholder="ETB" />
      </Field>
      {monitor ? (
        <>
          <Field label={taskText(lang, "monitorDelay")} hint={taskText(lang, "inherit")}>
            <TextInput inputMode="numeric" value={form.overrides?.monitorDelayMs ?? ""} placeholder={inheritedDelay} onChange={(event) => {
              const overrides = { ...form.overrides }
              const raw = event.target.value
              if (!raw.trim()) delete overrides.monitorDelayMs
              else overrides.monitorDelayMs = Math.round(Number(raw))
              onChange({ ...form, overrides })
            }} />
          </Field>
          <Field label={clientText(lang, "filter")}>
            <Select value={form.clientId || ME_CLIENT_ID} disabled={live} onChange={(event) => onChange({ ...form, clientId: event.target.value })}>
              {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </Select>
          </Field>
          <Field label={taskText(lang, "proxy")}>
            <Select value={form.monitorProxyGroupId ?? ""} disabled={live} onChange={(event) => onChange({ ...form, monitorProxyGroupId: event.target.value || null, proxyGroupId: null })}>
              <option value="">{taskText(lang, "direct")}</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </Select>
          </Field>
          <Field label={taskText(lang, "priceCap")}>
            <TextInput type="number" min={0} step="0.01" value={form.priceCap ?? ""} onChange={(event) => onChange({ ...form, priceCap: event.target.value === "" ? null : Number(event.target.value) })} />
          </Field>
          <Field className="span-2" label={taskText(lang, "webhook")}>
            <TextInput value={form.webhook ?? ""} onChange={(event) => onChange({ ...form, webhook: event.target.value })} placeholder="https://discord.com/api/webhooks/" inputMode="url" />
          </Field>
          <Field className="span-2" label={taskText(lang, "hours")} hint={taskText(lang, "hoursHint")}>
            <textarea value={form.activeHours ?? ""} onChange={(event) => onChange({ ...form, activeHours: event.target.value })} rows={3} />
          </Field>
          <Field className="span-2" label={taskText(lang, "links")}>
            <Select multiple value={form.linkedCheckoutIds ?? []} onChange={(event) => onChange({ ...form, linkedCheckoutIds: [...event.target.selectedOptions].map((option) => option.value) })}>
              {checkouts.map((task) => <option key={task.id} value={task.id}>{storeName(task.store)} · {task.sku}</option>)}
            </Select>
          </Field>
        </>
      ) : (
        <>
          <Field label={taskText(lang, "quantity")} hint={recommended ? deskText(lang, fieldMark(form.quantity, recommended.quantity) === "custom" ? "markCustom" : "markDefault") : undefined}>
            <TextInput type="number" min={1} max={12} value={form.quantity} disabled={live} onChange={(event) => onChange({ ...form, quantity: Number(event.target.value) })} required />
          </Field>
          <Field label={taskText(lang, "profile")}>
            <Select value={form.profileId} disabled={live} onChange={(event) => onChange({ ...form, profileId: event.target.value })} required>
              <option value="">—</option>
              {profileChoices.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.last4}</option>)}
            </Select>
          </Field>
          <Field label={taskText(lang, "account")}>
            <Select value={form.accountId} disabled={live} onChange={(event) => {
              const accountId = event.target.value
              const next = accounts.find((account) => account.id === accountId)
              const profile = profiles.find((item) => item.id === form.profileId)
              const mismatch = Boolean(next && profile && clientIdOf(profile.clientId) !== clientIdOf(next.clientId))
              onChange({ ...form, accountId, profileId: mismatch ? "" : form.profileId })
            }} required>
              <option value="">—</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
            </Select>
          </Field>
          <Field label={taskText(lang, "proxy")}>
            <Select value={form.monitorProxyGroupId ?? ""} disabled={live} onChange={(event) => onChange({ ...form, monitorProxyGroupId: event.target.value || null })}>
              <option value="">{taskText(lang, "sameProxy")}</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </Select>
          </Field>
          <Field label={taskText(lang, "checkoutProxy")}>
            <Select value={form.proxyGroupId ?? ""} disabled={live} onChange={(event) => onChange({ ...form, proxyGroupId: event.target.value || null })}>
              <option value="">{taskText(lang, "direct")}</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.proxies?.length ?? 0})</option>)}
            </Select>
          </Field>
          <Field label={taskText(lang, "checkoutDelay")}>
            <TextInput type="number" min={0} value={form.checkoutDelayMs ?? ""} onChange={(event) => onChange({ ...form, checkoutDelayMs: event.target.value === "" ? null : Number(event.target.value) })} />
          </Field>
          <Field label={taskText(lang, "maxPrice")}>
            <TextInput type="number" min={0} step="0.01" value={form.maxPrice ?? ""} onChange={(event) => onChange({ ...form, maxPrice: event.target.value === "" ? null : Number(event.target.value) })} />
          </Field>
          <Field label={taskText(lang, "startMode")}>
            <Select value={form.startMode ?? "builtin"} disabled={live} onChange={(event) => {
              const startMode = event.target.value as StartMode
              onChange({ ...form, startMode, linkedMonitorId: startMode === "monitor" ? form.linkedMonitorId ?? null : null })
            }}>
              {modes.map((mode) => <option key={mode} value={mode}>{taskText(lang, mode === "monitor" ? "monitorStart" : mode === "builtin" ? "builtin" : mode)}</option>)}
            </Select>
          </Field>
          {form.startMode === "monitor" ? (
            <Field className="span-2" label={taskText(lang, "linkMonitor")} hint={taskText(lang, "linkMonitorHint")}>
              <Select value={form.linkedMonitorId ?? ""} disabled={live} onChange={(event) => onChange({ ...form, linkedMonitorId: event.target.value || null })}>
                <option value="">{taskText(lang, "noMonitor")}</option>
                {monitors.map((task) => <option key={task.id} value={task.id}>{storeName(task.store)} · {task.sku || task.keywords || task.id}</option>)}
              </Select>
            </Field>
          ) : null}
          <label className="check span-2">
            <input type="checkbox" checked={form.testMode === true} disabled={live && form.testMode === true} onChange={(event) => onChange({ ...form, testMode: event.target.checked })} />
            <span>{taskText(lang, "testMode")}</span>
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.confirmPurchase} disabled={live && !form.confirmPurchase} onChange={(event) => onChange({ ...form, confirmPurchase: event.target.checked })} />
            <span>{taskText(lang, "confirm")}</span>
          </label>
        </>
      )}
      {selectedStore && !selectedStore.implemented ? (
        <Banner tone="info">{selectedStore.name} is registered, and starting a task records that checkout is not implemented yet.</Banner>
      ) : null}
      {settings ? <details className="advanced span-2"><summary>{deskText(lang, "advanced")}</summary><TaskOverrides form={form} settings={settings} onChange={onChange} /></details> : null}
      <BindingNote form={form} accounts={accounts} groups={groups} lang={lang} />
      <div className="actions span-2">
        <button className="primary" type="submit" disabled={busy}>{form.id ? "Save task" : "Create task"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function BindingNote({ form, accounts, groups, lang }: { form: TaskInput; accounts: PublicAccount[]; groups: ProxyGroup[]; lang: "en" | "es" }) {
  if (form.kind === "monitor") {
    return (
      <div className="span-2">
        <p className="hint">{taskText(lang, "monitorAnonymous")}</p>
      </div>
    )
  }
  const account = accounts.find((item) => item.id === form.accountId) ?? null
  const binding = effectiveBinding({
    accountId: form.accountId,
    proxyGroupId: form.proxyGroupId ?? null,
    monitorProxyGroupId: form.monitorProxyGroupId ?? null,
    account,
    groups
  })
  return (
    <div className="span-2">
      <p className="hint">{taskText(lang, "account")}: {binding.accountSource === "none" ? consistencyText(lang, "fromNone") : binding.accountLabel} · {consistencyText(lang, binding.accountSource === "task" ? "fromAccount" : "fromNone")}</p>
      <p className="hint">{consistencyText(lang, "profile")}: {binding.profileLabel || consistencyText(lang, "fromNone")} · {consistencyText(lang, binding.profileSource === "account" ? "fromAccount" : "fromNone")}</p>
      <p className="hint">{consistencyText(lang, "stickyProxy")}: {binding.proxyLabel || consistencyText(lang, "fromDirect")} · {consistencyText(lang, binding.proxySource === "account" ? "fromAccount" : binding.proxySource === "task" ? "fromTask" : "fromDirect")}</p>
      {binding.warnings.map((warning) => <Banner key={warning} tone="info">{consistencyText(lang, warning === "sticky" ? "stickyWarning" : "monitorWarning")}</Banner>)}
    </div>
  )
}

function applyRole(form: TaskInput, kind: TaskKind, settings: Settings | null): TaskInput {
  const base: TaskInput = {
    ...form,
    kind,
    monitorOnly: kind === "monitor",
    confirmPurchase: kind === "monitor" ? false : form.confirmPurchase,
    startMode: kind === "monitor" ? (form.startMode === "scheduled" ? "scheduled" : "manual") : (form.startMode ?? "builtin"),
    linkedMonitorId: kind === "monitor" ? null : form.linkedMonitorId ?? null
  }
  if (form.id || !settings) return base
  const role = prefillRole(form.store, kind === "monitor" ? "monitor" : "checkout", settings.storeRoles)
  return { ...base, quantity: role.quantity, maxPrice: role.maxPrice, checkoutDelayMs: role.checkoutDelayMs, testMode: role.testMode }
}

function freshTask(settings: Settings | null, kind: TaskKind = "checkout"): TaskInput {
  return applyRole(emptyForm(), kind, settings)
}

function TaskOverrides({ form, settings, onChange }: { form: TaskInput; settings: Settings; onChange: (next: TaskInput) => void }) {
  const lang = settings.language === "es" ? "es" : "en"
  const resolved = resolveModule(form.store, moduleScope(settings), form.overrides)
  function setNumber(key: "monitorDelayMs" | "retryDelayMs" | "rateLimitMs" | "maxRetries" | "blockBackoffMs", raw: string) {
    const overrides = { ...form.overrides }
    if (!raw.trim()) delete overrides[key]
    else overrides[key] = Math.round(Number(raw))
    onChange({ ...form, overrides })
  }
  return (
    <div className="span-2">
      <h2>{moduleText(lang, "overrides")}</h2>
      <p>{moduleText(lang, "overrideHint")} {moduleText(lang, "rateLimitMs")}: {resolved.rateLimitMs.value} ms · {sourceLabel(lang, resolved.rateLimitMs.source)}. {moduleText(lang, "maxRetries")}: {resolved.maxRetries.value} · {sourceLabel(lang, resolved.maxRetries.source)}. {taskText(lang, "jitter")}: {form.jitterPct ?? settings.monitorJitterPct}% · {sourceLabel(lang, form.jitterPct === null || form.jitterPct === undefined ? "global" : "task")}.</p>
      <div className="form-grid">
        {form.kind === "monitor" ? null : (
          <Field label={moduleText(lang, "monitorDelayMs")} hint={taskText(lang, "inherit")}>
            <TextInput value={form.overrides?.monitorDelayMs ?? ""} placeholder={String(resolved.monitorDelayMs.value)} onChange={(event) => setNumber("monitorDelayMs", event.target.value)} />
          </Field>
        )}
        <Field label={moduleText(lang, "retryDelayMs")}>
          <TextInput value={form.overrides?.retryDelayMs ?? ""} placeholder={String(resolved.retryDelayMs.value)} onChange={(event) => setNumber("retryDelayMs", event.target.value)} />
        </Field>
        <Field label={moduleText(lang, "rateLimitMs")} hint={taskText(lang, "inherit")}>
          <TextInput value={form.overrides?.rateLimitMs ?? ""} placeholder={String(resolved.rateLimitMs.value)} onChange={(event) => setNumber("rateLimitMs", event.target.value)} />
        </Field>
        <Field label={moduleText(lang, "maxRetries")}>
          <TextInput value={form.overrides?.maxRetries ?? ""} placeholder={String(resolved.maxRetries.value)} onChange={(event) => setNumber("maxRetries", event.target.value)} />
        </Field>
        <Field label={moduleText(lang, "blockBackoffMs")}>
          <TextInput value={form.overrides?.blockBackoffMs ?? ""} placeholder={String(resolved.blockBackoffMs.value)} onChange={(event) => setNumber("blockBackoffMs", event.target.value)} />
        </Field>
        <Field label={taskText(lang, "jitter")} hint={taskText(lang, "jitterHint")}>
          <TextInput type="number" min={0} max={40} value={form.jitterPct ?? ""} placeholder={String(settings.monitorJitterPct)} onChange={(event) => onChange({ ...form, jitterPct: event.target.value === "" ? null : Number(event.target.value) })} />
        </Field>
        <Field label={taskText(lang, "zip")}>
          <TextInput value={form.overrides?.zips ?? ""} placeholder={resolved.zips.value || taskText(lang, "inherit")} onChange={(event) => {
            const overrides = { ...form.overrides }
            if (!event.target.value.trim()) delete overrides.zips
            else overrides.zips = event.target.value
            onChange({ ...form, overrides })
          }} />
        </Field>
        <Field label={taskText(lang, "soldBy")}>
          <Select value={form.overrides?.soldBy ?? ""} onChange={(event) => {
            const overrides = { ...form.overrides }
            if (!event.target.value) delete overrides.soldBy
            else overrides.soldBy = event.target.value as "retailer" | "any"
            onChange({ ...form, overrides })
          }}>
            <option value="">{taskText(lang, "inherit")} · {resolved.soldBy.value}</option>
            <option value="retailer">{taskText(lang, "retailer")}</option>
            <option value="any">{taskText(lang, "anySeller")}</option>
          </Select>
        </Field>
        {form.kind !== "monitor" ? (
          <Field label={taskText(lang, "atc")}>
            <Select value={form.overrides?.atcMode ?? ""} onChange={(event) => {
              const overrides = { ...form.overrides }
              if (!event.target.value) delete overrides.atcMode
              else overrides.atcMode = event.target.value as "fast" | "standard"
              onChange({ ...form, overrides })
            }}>
              <option value="">{taskText(lang, "inherit")} · {resolved.atcMode.value}</option>
              <option value="fast">Fast</option>
              <option value="standard">Standard</option>
            </Select>
          </Field>
        ) : null}
      </div>
    </div>
  )
}
