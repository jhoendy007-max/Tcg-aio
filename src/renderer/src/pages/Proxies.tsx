import { useEffect, useState } from "react"
import { formatProxy } from "../../../shared/proxy"
import type { ProxyGroup, ProxyTestResult } from "../../../shared/types"
import { Banner, Field, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function ProxiesPage() {
  const [groups, setGroups] = useState<ProxyGroup[]>([])
  const [name, setName] = useState("")
  const [text, setText] = useState("")
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, ProxyTestResult[]>>({})
  const [testing, setTesting] = useState<string | null>(null)

  async function reload() {
    setGroups(await unwrap(window.aio.proxies.list()))
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await unwrap(window.aio.proxies.save({ id: editing, name, text }))
      setName("")
      setText("")
      setEditing(undefined)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function test(id: string) {
    setTesting(id)
    setError("")
    try {
      const next = await unwrap(window.aio.proxies.test(id))
      setResults((current) => ({ ...current, [id]: next }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setTesting(null)
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this proxy group?")) return
    setError("")
    try {
      await unwrap(window.aio.proxies.delete(id))
      await reload()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Proxies</h1>
          <p>Import a list, then test each proxy. A task sticks to one proxy from its group for the whole run.</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <form className="card stack" onSubmit={save}>
        <Field label="Group name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Residential" required />
        </Field>
        <Field label="Proxy list" hint="host:port, host:port:user:pass, or user:pass@host:port. Lines starting with # are ignored.">
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={8} placeholder={"203.0.113.10:8000\n203.0.113.11:8000:user:pass"} required />
        </Field>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>{editing ? "Update group" : "Save group"}</button>
          {editing ? <button type="button" onClick={() => { setEditing(undefined); setName(""); setText("") }}>Cancel</button> : null}
        </div>
      </form>
      <div className="stack">
        {groups.length === 0 ? <div className="card empty">No proxy groups yet.</div> : groups.map((group) => (
          <article key={group.id} className="card proxy-group">
            <div className="proxy-head">
              <div>
                <h2>{group.name}</h2>
                <span>{group.proxies.length} proxies</span>
              </div>
              <div className="actions">
                <button type="button" onClick={() => { setEditing(group.id); setName(group.name); setText(group.proxies.map(formatProxy).join("\n")) }}>Edit</button>
                <button type="button" onClick={() => void test(group.id)} disabled={testing === group.id}>{testing === group.id ? "Testing…" : "Test"}</button>
                <button type="button" className="danger" onClick={() => void remove(group.id)}>Delete</button>
              </div>
            </div>
            {results[group.id] ? (
              <ul className="proxy-results">
                {results[group.id].map((result) => (
                  <li key={result.id} className={result.ok ? "ok" : "bad"}>
                    <span>{result.label}</span>
                    <span>{result.ok ? `Alive ${result.ip ?? ""}` : result.error}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  )
}
