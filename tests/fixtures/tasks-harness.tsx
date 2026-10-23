// Renders the real TasksPage inside the app shell with a fake window.aio, for layout tests and screenshots.
window.addEventListener("error", (e) => { const p = document.createElement("pre"); p.id = "err"; p.textContent = String(e.message) + " " + (e.error?.stack ?? ""); document.body.append(p) })
import { createRoot } from "react-dom/client"
import { TasksPage } from "../../src/renderer/src/pages/Tasks"

const params = new URLSearchParams(location.search)
const count = Number(params.get("n") ?? "1")
const stores = ["target", "walmart", "bestbuy", "amazon", "pokemon-center"]
const tasks = Array.from({ length: count }, (_, index) => ({
  id: `t${index}`,
  store: index === 0 ? "target" : stores[index % stores.length],
  sku: index === 0 ? "1005422418" : `${94300000 + index * 137}`,
  quantity: 1, profileId: "", accountId: "", proxyGroupId: null, monitorProxyGroupId: null,
  confirmPurchase: false, testMode: false, group: "", kind: "monitor", monitorOnly: true,
  status: index % 4 === 1 ? "monitoring" : "idle", logs: index % 4 === 1 ? [{ ts: 1, message: index % 8 === 1 ? "In stock" : "Out of stock" }] : []
}))
const titles = [{ store: "walmart", sku: `${94300000 + 137}`, title: "Prismatic Evolutions Elite Trainer Box" }]
const data: Record<string, unknown> = {
  "tasks.list": tasks, "profiles.list": [], "accounts.list": [], "proxies.list": [], "clients.list": [],
  "stores.list": stores.map((id) => ({ id, name: id, implemented: true })),
  "settings.get": { settings: { language: "en", testMode: false } }, "analytics.get": { stockLog: titles }, "challenge.get": null, "checkoutHealth.tasks": []
}
const area = (name: string) => new Proxy({}, { get: (_t, method: string) => method === "onEvent" ? () => () => undefined : () => Promise.resolve({ ok: true, data: `${name}.${method}` in data ? data[`${name}.${method}`] : [] }) })
;(window as unknown as { aio: unknown }).aio = new Proxy({}, { get: (_t, name: string) => area(name) })

createRoot(document.getElementById("root")!).render(
  <div className="shell"><aside className="sidebar"><div className="brand"><strong>Zzz AIO</strong></div></aside><main><TasksPage /></main></div>
)

setTimeout(() => {
  if (params.get("open")) (document.querySelector(".row-menu-button") as HTMLButtonElement | null)?.click()
  setTimeout(() => {
    const wrap = document.querySelector(".task-table") as HTMLElement | null
    const menu = document.querySelector(".popover.row-menu-list") as HTMLElement | null
    const r = menu?.getBoundingClientRect()
    const clipped = (() => {
      if (!menu || !r) return null
      for (let el = menu.parentElement; el && el !== document.body; el = el.parentElement) if (getComputedStyle(el).overflow !== "visible") return true
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !(hit && menu.contains(hit))
    })()
    const out = {
      rows: document.querySelectorAll("tr.task-row").length,
      wrapInnerScroll: wrap ? wrap.scrollHeight > wrap.clientHeight + 1 : null,
      wrapOverflowY: wrap ? getComputedStyle(wrap).overflowY : null,
      menu: r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, items: menu!.querySelectorAll("button").length, inBody: menu!.parentElement === document.body } : null,
      clipped,
      viewport: { width: innerWidth, height: innerHeight },
      skuTag: document.querySelectorAll(".sku-tag").length,
      named: Array.from(document.querySelectorAll(".product-name")).some((el) => el.textContent?.includes("Prismatic"))
    }
    const pre = document.createElement("pre"); pre.id = "result"; pre.textContent = JSON.stringify(out); pre.style.display = "none"; document.body.append(pre)
  }, 300)
}, 600)
