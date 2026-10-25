import { describe, expect, it } from "vitest"
import { ClawHttp, profileForPartition } from "../src/browser/claw-http"

function fake(options?: { idleMs?: number; maxLive?: number }) {
  const opened: string[] = []
  const closed: string[] = []
  const http = new ClawHttp(
    async (profile) => {
      opened.push(profile)
      return {
        close: async () => {
          closed.push(profile)
        },
        context: {
          request: {
            fetch: async () => ({
              status: () => 200,
              text: async () => "ok",
              headersArray: () => [{ name: "Set-Cookie", value: "a=1" }, { name: "set-cookie", value: "b=2" }]
            })
          }
        } as never
      }
    },
    { idleMs: 0, ...options }
  )
  return { http, opened, closed }
}

const get = (account: string) => ({ method: "GET" as const, url: "https://x.test", partition: `persist:account-${account}` })

describe("claw http", () => {
  it("maps partitions to profiles", () => {
    expect(profileForPartition("persist:account-7")).toBe("acct-7")
    expect(profileForPartition(undefined)).toBe("monitor")
  })
  it("opens one profile per account and keeps repeated headers", async () => {
    const { http, opened } = fake()
    const a = await http.request(get("1"))
    await http.request(get("1"))
    await http.request(get("2"))
    expect(opened).toEqual(["acct-1", "acct-2"])
    expect(a.headers["set-cookie"]).toEqual(["a=1", "b=2"])
    expect(a.body).toBe("ok")
  })
  it("runs 500 accounts with only a few live profiles", async () => {
    const { http, opened } = fake({ maxLive: 5 })
    let peak = 0
    const watch = setInterval(() => {
      peak = Math.max(peak, http.live)
    }, 1)
    await Promise.all(Array.from({ length: 500 }, (_, i) => http.request(get(String(i)))))
    clearInterval(watch)
    expect(opened.length).toBe(500)
    expect(peak).toBeLessThanOrEqual(5)
  })
  it("closes idle profiles and closes everything on shutdown", async () => {
    const { http, closed } = fake({ idleMs: 5 })
    await http.request(get("1"))
    await new Promise((r) => setTimeout(r, 40))
    expect(closed).toEqual(["acct-1"])
    await http.request(get("2"))
    await http.closeAll()
    expect(closed).toEqual(["acct-1", "acct-2"])
  })
})
