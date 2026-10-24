import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { BAR_CHANNELS, BAR_HEIGHT, barHtml, barWords, copyWithAutoClear, escapeHtml, type ClipboardLike } from "../src/engine/signin-bar"

const password = "S3cret!Pass-123"

function fakeClipboard(): ClipboardLike & { text: string } {
  return {
    text: "",
    writeText(value) {
      this.text = value
    },
    readText() {
      return this.text
    },
    clear() {
      this.text = ""
    }
  }
}

function fakeTimers() {
  const jobs: { fn: () => void; ms: number; live: boolean }[] = []
  return {
    jobs,
    set: (fn: () => void, ms: number) => {
      const job = { fn, ms, live: true }
      jobs.push(job)
      return job
    },
    clear: (handle: unknown) => {
      ;(handle as { live: boolean }).live = false
    },
    fire() {
      for (const job of jobs) if (job.live) job.fn()
    }
  }
}

describe("sign-in bar (0.2.44)", () => {
  it("shows the email and a masked password and never puts the password in the page", () => {
    const html = barHtml({ label: "Ada <Target>", username: "ada@example.com", hasPassword: true, lang: "en", nonce: "abc" })
    expect(html).toContain("ada@example.com")
    expect(html).toContain("•".repeat(12))
    expect(html).toContain("Ada &lt;Target&gt;")
    expect(html).not.toContain(password)
    expect(html).toContain("script-src 'nonce-abc'")
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("Show")
    expect(html).toContain("Copy")
  })

  it("handles an account with no saved password and Spanish text", () => {
    const html = barHtml({ label: "Ada", username: "ada@example.com", hasPassword: false, lang: "es", nonce: "n" })
    expect(html).toContain(barWords("es").none)
    expect(html).not.toContain('id="cpass"')
    expect(barWords("es").copy).toBe("Copiar")
    expect(escapeHtml(`<"&'>`)).toBe("&lt;&quot;&amp;&#39;&gt;")
  })

  it("clears the clipboard after 30 s only if it still holds the copied value", () => {
    const clipboard = fakeClipboard()
    const timers = fakeTimers()
    copyWithAutoClear(clipboard, password, 30_000, timers)
    expect(clipboard.text).toBe(password)
    expect(timers.jobs[0]?.ms).toBe(30_000)
    timers.fire()
    expect(clipboard.text).toBe("")

    const other = fakeClipboard()
    const t2 = fakeTimers()
    copyWithAutoClear(other, password, 30_000, t2)
    other.writeText("something the person copied later")
    t2.fire()
    expect(other.text).toBe("something the person copied later")

    const third = fakeClipboard()
    const t3 = fakeTimers()
    const cancel = copyWithAutoClear(third, password, 30_000, t3)
    cancel()
    t3.fire()
    expect(third.text).toBe(password)
  })

  it("keeps the bar out of the store page and the password out of logs and the page renderer", () => {
    const main = readFileSync("src/main/signin-bar.ts", "utf8")
    const windowSource = readFileSync("src/main/session-window.ts", "utf8")
    const preload = readFileSync("src/preload/signin-bar.ts", "utf8")
    expect(main).not.toMatch(/console\./)
    expect(main).not.toMatch(/insertCSS|executeJavaScript|webContents\.send/)
    expect(preload).toContain(BAR_CHANNELS.copy)
    expect(preload).toContain(BAR_CHANNELS.reveal)
    expect(windowSource).toContain("attachSigninBar(")
    // The only page script reads text for the store error banner. Nothing is typed or filled.
    expect(windowSource).not.toMatch(/executeJavaScript\([^)]*(password|value\s*=)/i)
    expect(windowSource).not.toMatch(/console\.[a-z]+\([^)]*password/i)
    // Reveal answers only the bar's own webContents.
    expect(main).toContain("states.get(event.sender.id)")
    expect(BAR_HEIGHT).toBeGreaterThan(30)
    expect(readFileSync("electron.vite.config.ts", "utf8")).toContain("signin-bar")
  })
})
