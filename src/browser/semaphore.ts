/** FIFO counting semaphore. Lets 500 tasks queue while only `limit` run. */
export class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be a positive integer.")
  }

  get running(): number {
    return this.active
  }

  get queued(): number {
    return this.waiting.length
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("Aborted"))
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort)
        this.active += 1
        let done = false
        resolve(() => {
          if (done) return
          done = true
          this.active -= 1
          this.waiting.shift()?.()
        })
      }
      const onAbort = (): void => {
        const at = this.waiting.indexOf(grant)
        if (at >= 0) this.waiting.splice(at, 1)
        reject(new Error("Aborted"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (this.active < this.limit) grant()
      else this.waiting.push(grant)
    })
  }
}
