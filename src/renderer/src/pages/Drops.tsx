import { useEffect, useState } from "react"
import type { AnalyticsReport, DropSchedule, PublicTask } from "../../../shared/types"
import { countdown, formatAst, toAstInput } from "../../../engine/time"
import { Banner, Field, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

const blank = () => ({
  id: undefined as string | undefined,
  name: "",
  startAt: "",
  stopAt: "",
  warmupMin: 10,
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

  async function reload() {
    const [nextSchedules, nextTasks] = await Promise.all([
      unwrap(window.aio.schedules.list()),
      unwrap(window.aio.tasks.list())
    ])
    setSchedules(nextSchedules)
    setTasks(nextTasks)
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
            <p className="hint">Session Keeper {schedule.warmupMin} min before{schedule.stopAt ? ` · stops ${formatAst(schedule.stopAt)}` : ""}.</p>
            <div className="actions">
              <button type="button" onClick={() => setForm({ id: schedule.id, name: schedule.name, startAt: toAstInput(schedule.startAt), stopAt: schedule.stopAt ? toAstInput(schedule.stopAt) : "", warmupMin: schedule.warmupMin, group: schedule.group, taskIds: schedule.taskIds, enabled: schedule.enabled })}>Edit times</button>
              <button type="button" className="danger" onClick={() => void unwrap(window.aio.schedules.delete(schedule.id)).then(() => reload()).catch((err) => setError(errorText(err)))}>Delete</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
