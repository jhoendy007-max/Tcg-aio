import { useEffect, useState } from "react"
import type { PhoneInvite, PhoneStatus } from "../../../phone/protocol"
import { Banner, Field, TextInput } from "../components/ui"
import { errorText, formatTime, unwrap } from "../lib"

export function PhonePage() {
  const [status, setStatus] = useState<PhoneStatus | null>(null)
  const [invite, setInvite] = useState<PhoneInvite | null>(null)
  const [relay, setRelay] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    void unwrap(window.aio.phone.status())
      .then((next) => {
        setStatus(next)
        setRelay(next.relay)
      })
      .catch((err) => setError(errorText(err)))
    return window.aio.phone.onEvent((next) => setStatus(next))
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const inviteLive = invite && invite.inviteExpiresAt && invite.inviteExpiresAt > now ? invite : null
  const secondsLeft = inviteLive?.inviteExpiresAt ? Math.max(0, Math.ceil((inviteLive.inviteExpiresAt - now) / 1000)) : 0

  async function saveRelay() {
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const next = await unwrap(window.aio.phone.saveRelay(relay))
      setStatus(next)
      setRelay(next.relay)
      setMessage(next.relay ? "Relay saved. Pair again so the QR includes it." : "Relay cleared. Phones on this Wi-Fi can still pair.")
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function pair() {
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const next = await unwrap(window.aio.phone.invite())
      setInvite(next)
      setStatus(next)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string, name: string) {
    if (!window.confirm(`Revoke ${name}? That phone will have to pair again.`)) return
    setError("")
    try {
      setStatus(await unwrap(window.aio.phone.revoke(id)))
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Phone</h1>
          <p>The PC keeps monitoring and checking out. A paired phone can watch tasks and start or stop them. Card numbers, CVVs, and passwords stay on this PC.</p>
        </div>
        <button type="button" className="primary" onClick={() => void pair()} disabled={busy || !status?.listening}>Pair device</button>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      <div className="phone-grid">
        <div className="card qr-wrap">
          <h2>Pair device</h2>
          {inviteLive ? (
            <>
              <img className="qr" alt="Pairing QR code" src={inviteLive.qrDataUrl} />
              <p>Scan this with the TCGAIO phone app. It expires in {secondsLeft}s and works once.</p>
              <span className="mono">{status ? `${status.host}:${status.port}` : ""}</span>
            </>
          ) : (
            <p>Choose Pair device to show a one-time QR code. On the same Wi-Fi the phone connects directly. Away from home, save a relay first.</p>
          )}
        </div>
        <div className="stack">
          <form className="card form-grid" onSubmit={(event) => { event.preventDefault(); void saveRelay() }}>
            <Field className="span-2" label="Relay for away from home" hint="Optional ws:// or wss:// URL of a TCGAIO relay you run. Leave blank for Wi-Fi only. The relay routes encrypted frames and cannot read them.">
              <TextInput value={relay} onChange={(event) => setRelay(event.target.value)} placeholder="wss://relay.example.com" autoComplete="off" />
            </Field>
            <div className="actions span-2">
              <button className="primary" type="submit" disabled={busy}>Save relay</button>
              <span className="mono">{status?.listening ? `Listening on ${status.host}:${status.port}` : "Phone listener is off"}</span>
            </div>
          </form>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Phone</th>
                  <th>Paired</th>
                  <th>Last seen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {status && status.devices.length > 0 ? status.devices.map((device) => (
                  <tr key={device.id}>
                    <td>{device.name}</td>
                    <td>{formatTime(device.createdAt)}</td>
                    <td>{formatTime(device.lastSeenAt)}</td>
                    <td className="row-actions">
                      <button type="button" className="danger" onClick={() => void revoke(device.id, device.name)}>Revoke</button>
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={4} className="empty">No phones paired.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  )
}
