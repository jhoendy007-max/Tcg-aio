import { describe, expect, it } from "vitest"
import { parseEndpoint, profileName } from "../src/browser/claw-launch"
import { Semaphore } from "../src/browser/semaphore"

describe("claw launch helpers", () => {
  it("finds the endpoint in JSON or text", () => {
    expect(parseEndpoint('{"ok":true,"data":{"endpoint":"http://127.0.0.1:9222"}}')).toBe("http://127.0.0.1:9222")
    expect(parseEndpoint("http://127.0.0.1:9333")).toBe("http://127.0.0.1:9333")
    expect(parseEndpoint("{}")).toBeNull()
  })
  it("sanitizes profile names", () => {
    expect(profileName("acct 1/../x")).toBe("acct-1-..-x".replace("..", "--"))
  })
})

describe("semaphore", () => {
  it("runs 500 tasks with at most 20 at once", async () => {
    const gate = new Semaphore(20)
    let live = 0
    let peak = 0
    let done = 0
    await Promise.all(
      Array.from({ length: 500 }, async () => {
        const release = await gate.acquire()
        live += 1
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 1))
        live -= 1
        done += 1
        release()
      })
    )
    expect(done).toBe(500)
    expect(peak).toBeLessThanOrEqual(20)
  })
})
