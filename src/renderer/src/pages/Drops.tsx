import { useEffect, useState } from "react"
import { dropOpsText, type DropLang } from "../../../shared/drop-ops"
import { STORE_IDS, type AnalyticsReport, type CalendarEvent, type DropSchedule, type PublicAccount, type PublicProfile, type PublicTask, type StoreId } from "../../../shared/types"
import { countdown, formatAst, toAstInput } from "../../../engine/time"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

const blank = () => ({
  id: undefined as string | undefined,
  name: "",
  startAt: "",
  stopAt: "",
  warmupMin: 10,
  rehearsalMin: 0,
  group: "",
  taskIds: [] as string[],
  enabled: true
})

export function DropsPage() {
  const [schedules, setSchedules] = useState<DropSchedule[]>([])
  const [tasks, setTasks] = useState<PublicTask[]>([])
  const [form, setForm] = useState(blank)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState("")
  const [hints, setHints] = useState<AnalyticsReport["restockHints"]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [profiles, setProfiles] = useState<PublicProfile[]>([])
  const [lang, setLang] = useState<DropLang>("en")
  const [feed, setFeed] = useState("")
  const [release, setRelease] = useState<{ game: "pokemon" | "onepiece"; name: string; startAt: string; store: StoreId; sku: string }>({ game: "pokemon", name: "", startAt: "", store: "target", sku: "" })

  async function reload() {
    const [nextSchedules, nextTasks, nextEvents, nextAccounts, nextProfiles, settings] = await Promise.all([
      unwrap(window.aio.schedules.list()),
      unwrap(window.aio.tasks.list()),
      unwrap(window.aio.calendar.list()),
      unwrap(window.aio.accounts.list()),
      unwrap(window.aio.profiles.list()),
      unwrap(window.aio.settings.get())
    ])
    setSchedules(nextSchedules)
    setTasks(nextTasks)
    setEvents(nextEvents)
    setAccounts(nextAccounts)
    setProfiles(nextProfiles)
    setLang(settings.settings.language === "es" ? "es" : "en")
    const report = await unwrap(window.aio.analytics.get())
    setHints(report.restockHints)
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError("")
    try {
      await unwrap(window.aio.schedules.save(form))
      setForm(blank())
      await reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  function toggleTask(id: string) {
    setForm((current) => ({
      ...current,
      taskIds: current.taskIds.includes(id) ? current.taskIds.filter((item) => item !== id) : [...current.taskIds, id]
    }))
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Drops</h1>
          <p>Start and stop tasks at a clock time in Atlantic Time (Puerto Rico, UTC−4). Session Keeper warms the accounts that many minutes before the start. The phone gets a notification.</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {hints.length ? (
        <div className="card">
          <h2>Learned restock times</h2>
          {hints.map((hint) => <p key={`${hint.store}:${hint.sku}:${hint.hourAst}`} className="hint">{hint.detail}</p>)}
        </div>
      ) : null}
      <form className="card form-grid" onSubmit={save}>
        <Field label="Name"><TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></Field>
        <Field label="Warm-up (minutes before)" hint="0 skips the pre-drop Session Keeper pass. 0–180.">
          <TextInput type="number" min={0} max={180} value={form.warmupMin} onChange={(event) => setForm({ ...form, warmupMin: Number(event.target.value) })} required />
        </Field>
        <Field label={dropOpsText(lang, "rehearsal")} hint={dropOpsText(lang, "rehearsalHint")}>
          <TextInput type="number" min={0} max={180} value={form.rehearsalMin} onChange={(event) => setForm({ ...form, rehearsalMin: Number(event.target.value) })} required />
        </Field>
        <Field label="Start (Atlantic Time)"><TextInput type="datetime-local" value={form.startAt} onChange={(event) => setForm({ ...form, startAt: event.target.value })} required /></Field>
        <Field label="Stop (optional)"><TextInput type="datetime-local" value={form.stopAt} onChange={(event) => setForm({ ...form, stopAt: event.target.value })} /></Field>
        <Field label="Task group" hint="Every task with this group label is included, plus any you check.">
          <TextInput value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })} placeholder="ETB" />
        </Field>
        <div className="span-2 choices">
          {tasks.map((task) => (
            <label key={task.id} className="check">
              <input type="checkbox" checked={form.taskIds.includes(task.id)} onChange={() => toggleTask(task.id)} />
              <span>{task.sku}{task.group ? ` · ${task.group}` : ""}</span>
            </label>
          ))}
        </div>
        <div className="actions span-2"><button className="primary" type="submit">Schedule drop</button></div>
      </form>
      <div className="stack">
        {schedules.length === 0 ? <div className="card empty">No drops scheduled.</div> : schedules.map((schedule) => (
          <article key={schedule.id} className="card proxy-group">
            <div className="proxy-head">
              <div>
                <h2>{schedule.name}</h2>
                <span>{formatAst(schedule.startAt)} · {schedule.phase} · {schedule.taskIds.length} tasks{schedule.group ? ` · group ${schedule.group}` : ""}</span>
              </div>
              <div className="countdown">{schedule.phase === "started" || schedule.phase === "stopped" ? schedule.phase : countdown(schedule.startAt, now)}</div>
            </div>
            <p className="hint">Session Keeper {schedule.warmupMin} min before{schedule.rehearsalMin ? ` · rehearsal ${schedule.rehearsalMin} min before` : ""}{schedule.stopAt ? ` · stops ${formatAst(schedule.stopAt)}` : ""}.</p>
            <div className="actions">
              <button type="button" onClick={() => setForm({ id: schedule.id, name: schedule.name, startAt: toAstInput(schedule.startAt), stopAt: schedule.stopAt ? toAstInput(schedule.stopAt) : "", warmupMin: schedule.warmupMin, rehearsalMin: schedule.rehearsalMin, group: schedule.group, taskIds: schedule.taskIds, enabled: schedule.enabled })}>Edit times</button>
              <button type="button" className="danger" onClick={() => void unwrap(window.aio.schedules.delete(schedule.id)).then(() => reload()).catch((err) => setError(errorText(err)))}>Delete</button>
            </div>
          </article>
        ))}
      </div>
      <CalendarCard
        lang={lang}
        events={events}
        accounts={accounts}
        profiles={profiles}
        feed={feed}
        release={release}
        onFeed={setFeed}
        onRelease={setRelease}
        onError={setError}
        onSaved={() => reload()}
      />
    </section>
  )
}

function CalendarCard({ lang, events, accounts, profiles, feed, release, onFeed, onRelease, onError, onSaved }: {
  lang: DropLang
  events: CalendarEvent[]
  accounts: PublicAccount[]
  profiles: PublicProfile[]
  feed: string
  release: { game: "pokemon" | "onepiece"; name: string; startAt: string; store: StoreId; sku: string }
  onFeed: (value: string) => void
  onRelease: (value: { game: "pokemon" | "onepiece"; name: string; startAt: string; store: StoreId; sku: string }) => void
  onError: (value: string) => void
  onSaved: () => Promise<void>
}) {
  const [picks, setPicks] = useState<Record<string, string[]>>({})
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "")
  const [testMode, setTestMode] = useState(true)
  const t = (key: Parameters<typeof dropOpsText>[1]) => dropOpsText(lang, key)
  useEffect(() => {
    if (!profileId && profiles[0]) setProfileId(profiles[0].id)
  }, [profileId, profiles])

  async function saveDate(event: React.FormEvent) {
    event.preventDefault()
    onError("")
    try {
      await unwrap(window.aio.calendar.save({ ...release, note: "" }))
      onRelease({ ...release, name: "", sku: "" })
      await onSaved()
    } catch (err) {
      onError(errorText(err))
    }
  }

  async function importFeed() {
    onError("")
    try {
      await unwrap(window.aio.calendar.importFeed(feed))
      onFeed("")
      await onSaved()
    } catch (err) {
      onError(errorText(err))
    }
  }

  async function create(eventId: string, store: StoreId) {
    onError("")
    const chosen = picks[eventId] ?? []
    if (!profileId) {
      onError("Save a payment profile first.")
      return
    }
    try {
      await unwrap(window.aio.calendar.create({
        eventId,
        accountIds: chosen,
        profileId,
        quantity: 1,
        warmupMin: 10,
        rehearsalMin: 15,
        testMode,
        confirmPurchase: false
      }))
      await onSaved()
    } catch (err) {
      onError(errorText(err))
    }
    void store
  }

  return (
    <div className="card stack">
      <div>
        <h2>{t("calendarTitle")}</h2>
        <p className="hint">{t("calendarIntro")}</p>
      </div>
      <form className="form-grid" onSubmit={saveDate}>
        <Field label={t("game")}>
          <Select value={release.game} onChange={(event) => onRelease({ ...release, game: event.target.value === "onepiece" ? "onepiece" : "pokemon" })}>
            <option value="pokemon">{t("pokemon")}</option>
            <option value="onepiece">{t("onepiece")}</option>
          </Select>
        </Field>
        <Field label="Name"><TextInput value={release.name} onChange={(event) => onRelease({ ...release, name: event.target.value })} required /></Field>
        <Field label="Start (Atlantic Time)"><TextInput type="datetime-local" value={release.startAt} onChange={(event) => onRelease({ ...release, startAt: event.target.value })} required /></Field>
        <Field label="Store">
          <Select value={release.store} onChange={(event) => onRelease({ ...release, store: event.target.value as StoreId })}>
            {STORE_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
          </Select>
        </Field>
        <Field label="SKU"><TextInput value={release.sku} onChange={(event) => onRelease({ ...release, sku: event.target.value })} required /></Field>
        <div className="actions"><button className="primary" type="submit">{t("saveDate")}</button></div>
      </form>
      <Field label={t("importFeed")}>
        <textarea rows={5} value={feed} onChange={(event) => onFeed(event.target.value)} placeholder={'[{"game":"pokemon","name":"ETB","start":"2026-11-07T09:00","store":"target","sku":"88897904"}]'} />
      </Field>
      <div className="actions"><button type="button" onClick={() => void importFeed()}>{t("importButton")}</button></div>
      <Field label="Profile">
        <Select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </Select>
      </Field>
      <label className="check">
        <input type="checkbox" checked={testMode} onChange={(event) => setTestMode(event.target.checked)} />
        <span>Test mode. The created tasks do not place an order until you turn this off and confirm purchase on each task.</span>
      </label>
      {events.map((item) => {
        const matches = accounts.filter((account) => account.store === item.store)
        const chosen = picks[item.id] ?? []
        return (
          <article key={item.id} className="stack">
            <h2>{item.name}</h2>
            <p className="hint">{item.game === "pokemon" ? t("pokemon") : t("onepiece")} · {item.store} · {item.sku} · {formatAst(item.startAt)}</p>
            <div className="choices">
              {matches.map((account) => (
                <label key={account.id} className="check">
                  <input type="checkbox" checked={chosen.includes(account.id)} onChange={() => setPicks((current) => {
                    const ids = current[item.id] ?? []
                    return { ...current, [item.id]: ids.includes(account.id) ? ids.filter((id) => id !== account.id) : [...ids, account.id] }
                  })} />
                  <span>{account.label}</span>
                </label>
              ))}
            </div>
            <div className="actions">
              <button type="button" className="primary" onClick={() => void create(item.id, item.store)}>{t("createTasks")}</button>
              <button type="button" className="danger" onClick={() => void unwrap(window.aio.calendar.delete(item.id)).then(onSaved).catch((err) => onError(errorText(err)))}>Delete</button>
            </div>
          </article>
        )
      })}
    </div>
  )
}
