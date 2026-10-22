import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const cssPath = join(process.cwd(), "src/renderer/src/styles.css")

const routes = [
  "Dashboard",
  "Tasks",
  "Profiles",
  "Proxies",
  "Accounts",
  "ACO",
  "ACO locked",
  "Settings",
  "Settings · General",
  "Settings · Activity",
  "Settings · Store defaults",
  "Settings · Phone",
  "Settings · Alerts",
  "Settings · Drops",
  "Settings · Analytics",
  "Settings · Shipments",
  "Settings · Autopilot",
  "Settings · Sessions",
  "Settings · Sync"
]

const sizes = [
  { name: "small", width: 800, height: 500 },
  { name: "large", width: 1920, height: 1080 }
]

function chromeBin(): string {
  const fromEnv = process.env.CHROME_PATH?.trim()
  if (fromEnv) return fromEnv
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" })
    const path = found.stdout.trim()
    if (found.status === 0 && path) return path
  }
  throw new Error("Chrome is required for the shell scroll test. Set CHROME_PATH.")
}

function measure(width: number, height: number, expanded: boolean): Array<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "tcgaio-shell-"))
  copyFileSync(cssPath, join(dir, "styles.css"))
  const htmlPath = join(dir, "index.html")
  writeFileSync(htmlPath, fixture(expanded))
  const userData = join(dir, "chrome")
  const result = spawnSync(chromeBin(), [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--disable-extensions",
    "--remote-debugging-port=0",
    `--user-data-dir=${userData}`,
    `--window-size=${width},${height}`,
    "--virtual-time-budget=4000",
    "--dump-dom",
    htmlPath
  ], { encoding: "utf8", timeout: 150000, env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "/dev/null" } })
  if (result.error && !`${result.stdout}`.includes('id="result"')) throw result.error
  const dom = `${result.stdout}\n${result.stderr}`
  const match = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/)
  const body = match?.[1]?.trim() ?? ""
  if (!body.startsWith("[")) throw new Error(`Chrome did not report layout measurements.\n${dom.slice(-1500)}`)
  return JSON.parse(body) as Array<Record<string, unknown>>
}

function fixture(expanded: boolean): string {
  const labels = JSON.stringify(routes)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="styles.css" />
</head>
<body>
<div id="root">
  <div class="${expanded ? "shell expanded" : "shell rail"}">
    <aside class="sidebar">
      <div class="brand"><strong>TCGAIO</strong><span>v0.2.30</span></div>
      <nav>
        <a href="#home" aria-current="page">Dashboard</a>
        <a href="#tasks">Tasks</a>
        <a href="#profiles">Profiles</a>
        <a href="#proxies">Proxies</a>
        <a href="#accounts">Accounts</a>
        <a href="#aco">ACO</a>
        <a href="#settings">Settings</a>
      </nav>
      <footer><button type="button" class="icon-btn">«</button></footer>
    </aside>
    <main id="main"></main>
  </div>
</div>
<pre id="result"></pre>
<script>
const routes = ${labels}
const main = document.getElementById("main")
const sidebar = document.querySelector(".sidebar")
const rows = []
for (const name of routes) {
  main.innerHTML = '<section class="page"><h1>' + name + '</h1><div class="segments scroll-x"><a href="#settings" aria-current="page">General</a><a href="#settings/logs">Activity</a><a href="#settings/stores">Store defaults</a><a href="#settings/phone">Phone</a><a href="#settings/alerts">Alerts</a><a href="#settings/drops">Drops</a><a href="#settings/stats">Analytics</a><a href="#settings/ship">Shipments</a><a href="#settings/autopilot">Autopilot</a><a href="#settings/keeper">Sessions</a><a href="#settings/vault">Sync</a></div><div class="card" style="height:2400px">Tall ' + name + '</div></section>'
  main.scrollTop = 0
  const before = main.scrollTop
  main.scrollTop = 400
  const side = sidebar.getBoundingClientRect()
  rows.push({
    name,
    scrollHeight: main.scrollHeight,
    clientHeight: main.clientHeight,
    scrollTop: main.scrollTop,
    moved: main.scrollTop > before,
    overflows: main.scrollHeight > main.clientHeight,
    sidebarTop: side.top,
    sidebarHeight: side.height,
    innerHeight: window.innerHeight,
    bodyScroll: document.scrollingElement.scrollTop,
    shellDisplay: getComputedStyle(document.querySelector(".shell")).display,
    mainOverflow: getComputedStyle(main).overflowY,
    mainMinHeight: getComputedStyle(main).minHeight,
    rootMinHeight: getComputedStyle(document.getElementById("root")).minHeight
  })
}
document.getElementById("result").textContent = JSON.stringify(rows)
</script>
</body>
</html>`
}

describe("desktop shell scroll", () => {
  it("scrolls the main column on every route at small and large windows", () => {
    for (const size of sizes) {
      const rows = measure(size.width, size.height, size.name === "large")
      expect(rows.map((row) => row.name)).toEqual(routes)
      for (const row of rows) {
        expect(row.overflows, `${size.name} ${row.name}`).toBe(true)
        expect(row.moved, `${size.name} ${row.name}`).toBe(true)
        expect(Number(row.scrollTop), `${size.name} ${row.name}`).toBeGreaterThan(0)
        expect(Number(row.clientHeight), `${size.name} ${row.name}`).toBeLessThanOrEqual(Number(row.innerHeight) + 1)
        expect(Number(row.sidebarTop), `${size.name} ${row.name}`).toBe(0)
        expect(Math.abs(Number(row.sidebarHeight) - Number(row.innerHeight)), `${size.name} ${row.name}`).toBeLessThanOrEqual(1)
        expect(Number(row.bodyScroll), `${size.name} ${row.name}`).toBe(0)
        expect(row.shellDisplay, `${size.name} ${row.name}`).toBe("flex")
        expect(String(row.mainOverflow), `${size.name} ${row.name}`).toMatch(/auto|scroll/)
        expect(row.mainMinHeight, `${size.name} ${row.name}`).toBe("0px")
        expect(row.rootMinHeight, `${size.name} ${row.name}`).toBe("0px")
      }
    }
  }, 360000)
})
