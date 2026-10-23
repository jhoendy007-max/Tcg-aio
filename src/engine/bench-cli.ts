import { parseProxyLine } from "../shared/proxy"
import { benchmarkStores } from "./bench"

function arg(name: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? "" : ""
}

async function main(): Promise<void> {
  const count = Number(arg("--n") || "5")
  const proxyLine = arg("--proxy")
  const proxy = proxyLine ? parseProxyLine(proxyLine) : undefined
  if (proxyLine && !proxy) {
    console.error("Proxy must be host:port or host:port:user:pass.")
    process.exit(1)
  }
  const reports = await benchmarkStores({ n: Number.isFinite(count) ? count : 5, proxy: proxy ?? undefined })
  console.log("store            proxy           n  read  in  oos  block  t/o  parse    p50    p95")
  console.log("read = the stock parser understood the reply. 3xx counts as blocked. Timeout is 8s.")
  for (const row of reports) {
    console.log(
      `${row.store.padEnd(16)} ${row.proxy.padEnd(15)} ${String(row.checks).padStart(2)} ${String(row.success).padStart(5)} ${String(row.inStock).padStart(3)} ${String(row.outOfStock).padStart(4)} ${String(row.blocked).padStart(6)} ${String(row.timeouts).padStart(4)} ${String(row.parseErrors).padStart(6)} ${String(row.p50Ms).padStart(6)} ${String(row.p95Ms).padStart(6)}`
    )
    const failed = row.samples.find((sample) => !sample.ok)
    if (failed) console.log(`  ${failed.verdict}: ${failed.status ?? "-"} ${failed.error ?? ""}`)
  }
  console.log(JSON.stringify(reports.map((row) => ({
    store: row.store,
    proxy: row.proxy,
    checks: row.checks,
    success: row.success,
    successRate: row.successRate,
    p50Ms: row.p50Ms,
    p95Ms: row.p95Ms,
    statuses: row.samples.map((sample) => sample.status),
    verdicts: row.samples.map((sample) => sample.verdict)
  }))))
}

void main()
