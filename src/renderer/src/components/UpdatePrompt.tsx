import { useEffect, useState } from "react"
import type { UpdateStatus } from "../../../shared/types"
import { promptVisible, runningTaskWarning, shortenNotes, tasksAreRunning, updateInstallLabel } from "../../../shared/update-prompt"
import { errorText, unwrap } from "../lib"

export function UpdatePrompt({ update, onUpdate }: { update: UpdateStatus | null; onUpdate: (status: UpdateStatus) => void }) {
  const [later, setLater] = useState(false)
  const [running, setRunning] = useState(false)
  const [waitIdle, setWaitIdle] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (update?.status === "checking") {
      setLater(false)
      setWaitIdle(false)
    }
  }, [update?.status])

  const visible = Boolean(update && promptVisible(update.status, later))

  useEffect(() => {
    if (!visible) return
    let stop = false
    const refresh = () => {
      void unwrap(window.aio.tasks.list()).then((tasks) => {
        if (!stop) setRunning(tasksAreRunning(tasks))
      }).catch(() => undefined)
    }
    refresh()
    const unsubscribe = window.aio.tasks.onEvent(refresh)
    return () => {
      stop = true
      unsubscribe()
    }
  }, [visible])

  useEffect(() => {
    if (!waitIdle || running || !update) return
    if (update.status !== "available" && update.status !== "downloaded") return
    setWaitIdle(false)
    void install(update, onUpdate, setError)
  }, [waitIdle, running, update, onUpdate])

  if (!update || !visible) return null
  return (
    <div className="update-scrim" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <div className="update-modal">
        <h2 id="update-title">Update {update.version}</h2>
        <p className="update-notes">{shortenNotes(update.notes)}</p>
        {running ? <p className="update-warn">{runningTaskWarning()}</p> : null}
        {waitIdle ? <p className="hint">The update will install when the running tasks finish.</p> : null}
        {error ? <p className="update-warn">{error}</p> : null}
        <div className="actions">
          <button type="button" className="primary" disabled={update.status === "downloading"} onClick={() => void install(update, onUpdate, setError)}>{updateInstallLabel(update.status, update.percent ?? null)}</button>
          {running ? <button type="button" disabled={waitIdle} onClick={() => setWaitIdle(true)}>When tasks finish</button> : null}
          <button type="button" onClick={() => { setLater(true); setWaitIdle(false) }}>Later</button>
        </div>
      </div>
    </div>
  )
}

async function install(update: UpdateStatus, onUpdate: (status: UpdateStatus) => void, setError: (value: string) => void): Promise<void> {
  setError("")
  try {
    let current = update
    if (current.status === "available" || current.status === "downloading") {
      current = await unwrap(window.aio.updates.download())
      onUpdate(current)
      if (current.status !== "downloaded") return
    }
    await unwrap(window.aio.updates.install())
  } catch (err) {
    setError(errorText(err))
  }
}
