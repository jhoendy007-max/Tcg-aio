import { describe, expect, it } from "vitest"
import { classifyTraffic, pollQueue, queueDetail, queuePollMs } from "../src/engine/traffic"
import type { HttpResponse } from "../src/engine/http"

function response(status: number, body: string, headers: HttpResponse["headers"] = {}): HttpResponse {
  return { status, headers, body }
}

describe("traffic classification", () => {
  it("separates rate limits, hard blocks, challenge pages, and waiting rooms", () => {
    expect(classifyTraffic(response(429, "slow down"))).toBe("rate_limit")
    expect(classifyTraffic(response(403, "nope"))).toBe("hard_block")
    expect(classifyTraffic(response(412, "precondition"))).toBe("hard_block")
    expect(classifyTraffic(response(435, "{\"blockScript\":\"captcha\"}"))).toBe("hard_block")
    expect(classifyTraffic(response(200, "{\"ok\":true}"))).toBe("clear")
    expect(classifyTraffic(response(403, "<html><body>Please verify you are a human</body></html>"))).toBe("challenge")
    expect(classifyTraffic(response(200, "<!doctype html><html>captcha</html>"))).toBe("challenge")
    expect(classifyTraffic(response(200, "Pokemon ETB in stock"))).toBe("clear")
  })

  it("treats a queue page and a Best Buy please-wait as a queue, not a block", () => {
    const room = response(302, "", { location: "https://pokemoncenter.queue-it.net/?c=pokemon" })
    expect(classifyTraffic(room)).toBe("queue")
    const waiting = response(200, "<html>You are now in the waiting room. Queue position is updating.</html>")
    expect(classifyTraffic(waiting)).toBe("queue")
    const pleaseWait = response(429, "{\"errorCode\":\"CONSTRAINED_ITEM_DHV\"}", { a2ctransactionwait: "7" })
    expect(classifyTraffic(pleaseWait)).toBe("queue")
    expect(classifyTraffic(response(200, "<html>waiting room verify you are human</html>"))).toBe("challenge")
  })

  it("reads the wait the queue page asks for", () => {
    expect(queuePollMs(response(200, "", { "retry-after": "12" }), 4000)).toBe(12000)
    expect(queuePollMs(response(200, "{\"updateIntervalMs\":8000}"), 4000)).toBe(8000)
    expect(queuePollMs(response(200, "Please wait 9 seconds before refreshing."), 4000)).toBe(9000)
    expect(queuePollMs(response(200, "still waiting"), 2500)).toBe(2500)
    expect(queuePollMs(response(200, "", { "retry-after": "0" }), 4000)).toBe(1000)
    expect(queueDetail(response(200, "{\"usersInLineAheadOfYou\":14}"))).toBe("In queue. Ahead of you: 14.")
    expect(queueDetail(response(200, "queue"))).toBe("In queue. Waiting for the store to let this session through.")
  })

  it("keeps polling a GET on the same pace and returns the page that got through", async () => {
    const sleeps: number[] = []
    const notes: string[] = []
    let hits = 0
    const signal = new AbortController().signal
    const done = await pollQueue(response(200, "<html>You are now in line</html>", { "set-cookie": "Queue-it=1", "retry-after": "5" }), {
      method: "GET",
      fallbackMs: 3000,
      signal,
      sleep: async (ms) => { sleeps.push(ms) },
      again: async () => {
        hits += 1
        if (hits === 1) return response(200, "<html>You are now in line</html>", { "retry-after": "5", "set-cookie": "Queue-it=2" })
        return response(200, "<html>in stock</html>", { "set-cookie": "session=ok" })
      },
      onQueue: (detail) => notes.push(detail)
    })
    expect(sleeps).toEqual([5000, 5000])
    expect(notes).toHaveLength(2)
    expect(done.body).toContain("in stock")
    expect(done.headers["set-cookie"]).toEqual(["Queue-it=1", "Queue-it=2", "session=ok"])
  })

  it("does not replay a checkout POST just because the body mentions a queue", async () => {
    let hits = 0
    const done = await pollQueue(response(200, "You are now in line"), {
      method: "POST",
      fallbackMs: 3000,
      signal: new AbortController().signal,
      sleep: async () => undefined,
      again: async () => {
        hits += 1
        return response(200, "again")
      },
      onQueue: () => undefined
    })
    expect(hits).toBe(0)
    expect(done.body).toBe("You are now in line")
  })
})
