import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { chromeUserAgent } from "../src/engine/chrome-ua"
import {
  chromiumTiming,
  cookieDiff,
  cookieWrites,
  monitorPartition,
  parseCookieHeader,
  partitionForRequest,
  planChromiumCall,
  toHttpHeaders
} from "../src/engine/chromium-session"
import type { ProxyEndpoint } from "../src/shared/types"

const proxyA: ProxyEndpoint = { id: "a", host: "10.0.0.1", port: 8000, username: "user", password: "secret-pass" }
const proxyB: ProxyEndpoint = { id: "b", host: "10.0.0.2", port: 8000, username: "user", password: "secret-pass" }

describe("chromium partitions", () => {
  it("keeps an account on its persistent partition", () => {
    expect(partitionForRequest({ proxy: proxyA }, "acct-1")).toBe("persist:account-acct-1")
    expect(partitionForRequest({ partition: "monitor-direct", proxy: proxyA }, "acct-1")).toBe("persist:account-acct-1")
  })

  it("isolates monitor traffic per proxy and ignores the password", () => {
    expect(partitionForRequest({})).toBe("monitor-direct")
    expect(monitorPartition()).toBe("monitor-direct")
    const first = monitorPartition(proxyA)
    const rotated: ProxyEndpoint = { ...proxyA, password: "other-secret" }
    const again = monitorPartition(rotated)
    const otherUser = monitorPartition({ ...proxyA, username: "other" })
    expect(first).toBe(again)
    expect(first).not.toBe(otherUser)
    expect(first).not.toBe(monitorPartition(proxyB))
    expect(first.startsWith("monitor-")).toBe(true)
    expect(first.startsWith("persist:")).toBe(false)
    expect(first).not.toContain("secret")
  })
})

describe("chromium request mapping", () => {
  it("moves the jar cookie into the session plan and drops headers Chromium rejects", () => {
    const plan = planChromiumCall({
      method: "POST",
      url: "https://www.walmart.com/ip/1",
      headers: {
        accept: "application/json",
        cookie: "auth=1; CID=2",
        "content-length": "12",
        host: "www.walmart.com"
      },
      body: "{}",
      proxy: proxyA,
      redirect: "manual"
    })
    expect(plan.partition).toBe(monitorPartition(proxyA))
    expect(plan.redirect).toBe("manual")
    expect(plan.headers.accept).toBe("application/json")
    expect(plan.headers.cookie).toBeUndefined()
    expect(plan.headers["content-length"]).toBeUndefined()
    expect(plan.headers.host).toBeUndefined()
    expect(plan.cookies).toEqual([
      { name: "auth", value: "1" },
      { name: "CID", value: "2" }
    ])
  })

  it("updates an existing session cookie in place and adds a missing one", () => {
    const writes = cookieWrites("https://www.walmart.com/cart", parseCookieHeader("auth=new; seen=1"), [
      { name: "auth", value: "old", domain: ".walmart.com", path: "/", secure: true, httpOnly: true, hostOnly: false, sameSite: "lax" },
      { name: "seen", value: "1", hostOnly: true, path: "/" }
    ])
    expect(writes).toEqual([
      {
        name: "auth",
        value: "new",
        domain: ".walmart.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        expirationDate: undefined
      }
    ])
    const created = cookieWrites("https://www.bestbuy.com/", [{ name: "vt", value: "1" }], [])
    expect(created).toEqual([{ name: "vt", value: "1", path: "/", secure: true }])
  })

  it("keeps real set-cookie attributes and fills cookies only the session stored", () => {
    const headers = toHttpHeaders(
      {
        Location: ["/cart"],
        "set-cookie": ["auth=1; Path=/; HttpOnly", "sid=2; Path=/"],
        "content-encoding": "gzip",
        "content-length": "20"
      },
      ["auth=stale", "hop=9"]
    )
    expect(headers.location).toBe("/cart")
    expect(headers["set-cookie"]).toEqual(["auth=1; Path=/; HttpOnly", "sid=2; Path=/", "hop=9"])
    expect(headers["content-encoding"]).toBeUndefined()
    expect(headers["content-length"]).toBeUndefined()
    expect(cookieDiff(
      [{ name: "auth", value: "1" }],
      [{ name: "auth", value: "1" }, { name: "hop", value: "9" }]
    )).toEqual(["hop=9"])
  })

  it("records total time when Chromium does not report DNS or connect", () => {
    expect(chromiumTiming(10, 25.4, 40.2)).toEqual({ dnsMs: 0, connectMs: 0, ttfbMs: 15, totalMs: 30 })
  })
})

describe("chrome user agent", () => {
  it("uses the Chromium version this process reports", () => {
    expect(chromeUserAgent("130.0.6723.191")).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36"
    )
    expect(chromeUserAgent(undefined)).toContain("Chrome/0.0.0.0")
    expect(chromeUserAgent("130.0.6723.191")).not.toContain("Electron")
  })

  it("does not hardcode Chrome 131 in the app source", () => {
    expect(readTree(join(process.cwd(), "src")).includes("Chrome/131")).toBe(false)
  })
})

function readTree(dir: string): string {
  let text = ""
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "out") continue
      text += readTree(path)
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) text += readFileSync(path, "utf8")
  }
  return text
}
