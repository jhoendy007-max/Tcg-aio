export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError()
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    function finish() {
      signal.removeEventListener("abort", onAbort)
      if (signal.aborted) reject(abortError())
      else resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError"
}

function abortError(): Error {
  const err = new Error("The task was stopped.")
  err.name = "AbortError"
  return err
}
