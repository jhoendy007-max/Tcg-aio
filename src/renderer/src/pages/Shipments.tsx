import { useEffect, useState } from "react"
import { dropOpsText, type DropLang } from "../../../shared/drop-ops"
import { storeName } from "../../../shared/stores"
import type { OrderRecord } from "../../../shared/types"
import { Banner } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function ShipmentsPage() {
  const [orders, setOrders] = useState<OrderRecord[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [lang, setLang] = useState<DropLang>("en")
  const [note, setNote] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function reload() {
    const [next, settings] = await Promise.all([
      unwrap(window.aio.shipments.list()),
      unwrap(window.aio.settings.get())
    ])
    setOrders(next)
    setLang(settings.settings.language === "es" ? "es" : "en")
    setSelected((current) => current && next.some((order) => order.id === current) ? current : next[0]?.id ?? null)
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
  }, [])

  const order = orders.find((item) => item.id === selected) ?? null
  const t = (key: Parameters<typeof dropOpsText>[1]) => dropOpsText(lang, key)

  async function scan() {
    setBusy(true)
    setError("")
    setNote("")
    try {
      const result = await unwrap(window.aio.shipments.scan())
      setOrders(result.orders)
      setNote(result.note)
      if (result.orders[0]) setSelected(result.orders.find((item) => item.id === selected)?.id ?? result.orders[0].id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>{t("shipTitle")}</h1>
          <p>{t("shipIntro")}</p>
        </div>
        <button type="button" className="primary" disabled={busy} onClick={() => void scan()}>{t("shipScan")}</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {note ? <Banner tone="info">{note}</Banner> : null}
      {orders.length === 0 ? <div className="card empty">{t("shipEmpty")}</div> : (
        <div className="split">
          <div className="stack">
            {orders.map((item) => (
              <button key={item.id} type="button" className={`pick ${item.id === selected ? "selected" : ""}`} onClick={() => setSelected(item.id)}>
                <strong>{storeName(item.store)} · {item.orderId}</strong>
                <span>{item.sku} · {item.status}</span>
              </button>
            ))}
          </div>
          {order ? (
            <article className="card stack">
              <h2>{order.orderId}</h2>
              <p>{storeName(order.store)} · {order.sku}</p>
              <p>{t("shipStatus")}: {order.status}</p>
              <p>{t("carrier")}: {order.carrier || "—"}</p>
              <p>{t("tracking")}: {order.tracking || "—"}</p>
              <p className="hint">{order.detail}</p>
            </article>
          ) : null}
        </div>
      )}
    </section>
  )
}
