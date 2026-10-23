import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "esbuild"
import { beforeAll, describe, expect, it } from "vitest"

function chromeBin(): string {
  const fromEnv = process.env.CHROME_PATH?.trim()
  if (fromEnv) return fromEnv
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" })
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim()
  }
  throw new Error("Chrome is required for the task table layout test. Set CHROME_PATH.")
}

let dir = ""
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "zzz-tasks-"))
  const bundle = await build({ write: false, entryPoints: [join(process.cwd(), "tests/fixtures/tasks-harness.tsx")], bundle: true, jsx: "automatic", outfile: "app.js", loader: { ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl" }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" })
  copyFileSync(join(process.cwd(), "src/renderer/src/styles.css"), join(dir, "styles.css"))
  writeFileSync(join(dir, "index.html"), '<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="styles.css"></head><body><div id="root"></div><script>' + bundle.outputFiles[0].text.replace(/<\/script/g, "<\\/script") + '</script></body></html>')
}, 60_000)

export function measure(width: number, height: number, query: string): Record<string, any> {
  const result = spawnSync(chromeBin(), ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", `--user-data-dir=${join(dir, `chrome-${width}-${query.replace(/\W/g, "")}`)}`, `--window-size=${width},${height}`, "--virtual-time-budget=4000", "--dump-dom", `file://${join(dir, "index.html")}?${query}`], { encoding: "utf8", timeout: 60_000 })
  const match = result.stdout.match(/<pre id="result"[^>]*>([^<]*)<\/pre>/)
  if (!match) throw new Error(`harness did not report: ${result.stderr.slice(-400)}`)
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"))
}

describe("tasks table layout (0.2.36)", () => {
  for (const [width, height] of [[1280, 800], [1920, 1080]]) {
    it(`${width}px: one task has no inner scrollbar and its row menu is fully visible`, () => {
      const out = measure(width, height, "n=1&open=1")
      expect(out.rows).toBe(1)
      expect(out.wrapInnerScroll).toBe(false)
      expect(out.wrapOverflowY).toBe("visible")
      expect(out.menu).not.toBeNull()
      expect(out.menu.inBody).toBe(true)
      expect(out.menu.items).toBeGreaterThanOrEqual(3)
      expect(out.menu.top).toBeGreaterThanOrEqual(0)
      expect(out.menu.left).toBeGreaterThanOrEqual(0)
      expect(out.menu.bottom).toBeLessThanOrEqual(out.viewport.height)
      expect(out.menu.right).toBeLessThanOrEqual(out.viewport.width)
      expect(out.clipped).toBe(false)
      expect(out.skuTag).toBe(1)
    }, 90_000)

    it(`${width}px: twenty tasks grow the table instead of an inner scroll box`, () => {
      const out = measure(width, height, "n=20")
      expect(out.rows).toBe(20)
      expect(out.wrapInnerScroll).toBe(false)
      expect(out.named).toBe(true)
    }, 90_000)
  }
})
