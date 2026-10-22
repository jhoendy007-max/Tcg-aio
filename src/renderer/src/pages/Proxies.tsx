import { useEffect, useState } from "react"
import { consistencyText, healthScore } from "../../../shared/consistency"
import { formatProxy } from "../../../shared/proxy"
import type { ProxyGroup, ProxyNetwork, ProxyScore, ProxyStoreTestResult, ProxyTestResult } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function ProxiesPage() {
  const [groups, setGroups] = useState<ProxyGroup[]>([])
  const [name, setName] = useState("")
  const [network, setNetwork] = useState<ProxyNetwork>("residential")
  const [text, setText] = useState("")
  const [scores, setScores] = useState<ProxyScore[]>([])
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, ProxyTestResult[]>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [storeResults, setStoreResults] = useState<Record<string, ProxyStoreTestResult[]>>({})
  const [storeTesting, setStoreTesting] = useState<string | null>(null)
  const [lang, setLang] = useState<"en" | "es">("en")

  async function reload() {
    const [nextGroups, nextScores, settings] = await Promise.all([
      unwrap(window.aio.proxies.list()),
      unwrap(window.aio.proxies.health()),
      unwrap(window.aio.settings.get())
    ])
    setGroups(nextGroups)
    setScores(nextScores)
    setLang(settings.settings.language === "es" ? "es" : "en")
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await unwrap(window.aio.proxies.save({ id: editing, name, text, network }))
      setName("")
      setText("")
      setNetwork("residential")
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

  async function storeTest(id: string) {
    setStoreTesting(id)
    setError("")
    try {
      const next = await unwrap(window.aio.proxies.storeTest(id))
      setStoreResults((current) => ({ ...current, [id]: next }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setStoreTesting(null)
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
          <p>{consistencyText(lang, "proxyIntro")}</p>
          <p>{consistencyText(lang, "residentialNote")}</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <form className="card stack" onSubmit={save}>
        <Field label="Group name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Residential" required />
        </Field>
        <Field label="Network">
          <Select value={network} onChange={(event) => setNetwork(event.target.value as ProxyNetwork)}>
            <option value="residential">Residential</option>
            <option value="datacenter">Datacenter</option>
          </Select>
        </Field>
        <Field label="Proxy list" hint="host:port, host:port:user:pass, or user:pass@host:port. Lines starting with # are ignored.">
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={8} placeholder={"203.0.113.10:8000\n203.0.113.11:8000:user:pass"} required />
        </Field>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>{editing ? "Update group" : "Save group"}</button>
          {editing ? <button type="button" onClick={() => { setEditing(undefined); setName(""); setText(""); setNetwork("residential") }}>Cancel</button> : null}
        </div>
      </form>
      <div className="stack">
        {groups.length === 0 ? <div className="card empty">No proxy groups yet.</div> : groups.map((group) => (
          <article key={group.id} className="card proxy-group">
            <div className="proxy-head">
              <div>
                <h2>{group.name}</h2>
                <span>{group.proxies?.length ?? 0} proxies · {group.network}</span>
              </div>
              <div className="actions">
                <button type="button" onClick={() => { setEditing(group.id); setName(group.name); setNetwork(group.network); setText((group.proxies ?? []).map(formatProxy).join("\n")) }}>Edit</button>
                <button type="button" onClick={() => void test(group.id)} disabled={testing === group.id}>{testing === group.id ? "Testing…" : "Test"}</button>
                <button type="button" onClick={() => void storeTest(group.id)} disabled={storeTesting === group.id} title="Sends one real stock request per store through each proxy and shows OK or Blocked.">{storeTesting === group.id ? "Testing stores…" : "Test proxy against store"}</button>
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
            {storeResults[group.id] ? (
              <ul className="proxy-results">
                {storeResults[group.id].map((result) => (
                  <li key={`${result.proxyId}:${result.store}`} className={result.result === "ok" ? "ok" : "bad"}>
                    <span>{result.label} · {result.storeName}</span>
                    <span>{result.result === "ok" ? "OK" : result.result === "blocked" ? "Blocked" : "Error"} · {result.detail}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <ul className="proxy-results">
              {(group.proxies ?? []).map((proxy) => {
                const score = scores.find((item) => item.proxyId === proxy.id)
                const benched = score && score.benchedUntil > Date.now()
                return (
                  <li key={proxy.id} className={benched ? "bad" : "ok"}>
                    <span>{proxy.host}:{proxy.port}</span>
                    <span>{benched ? `${consistencyText(lang, "quarantined")} ${new Date(score.benchedUntil).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}` : score ? `${consistencyText(lang, "health")} ${healthScore(score)} · ${score.ok} ok · ${score.blocks}` : consistencyText(lang, "noSamples")}</span>
                  </li>
                )
              })}
            </ul>
          </article>
        ))}
      </div>
    </section>
  )
}
