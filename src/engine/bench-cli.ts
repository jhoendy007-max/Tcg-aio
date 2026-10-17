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
  console.log("store            proxy          n  ok   rate    p50    p95")
  for (const row of reports) {
    const rate = `${Math.round(row.successRate * 100)}%`.padStart(4)
    console.log(
      `${row.store.padEnd(16)} ${row.proxy.padEnd(14)} ${String(row.checks).padStart(2)} ${String(row.success).padStart(3)} ${rate} ${String(row.p50Ms).padStart(6)} ${String(row.p95Ms).padStart(6)}`
    )
    const failed = row.samples.find((sample) => !sample.ok)
    if (failed) console.log(`  ${failed.status ?? "error"} ${failed.error ?? "not a stock response"}`)
  }
  console.log(JSON.stringify(reports.map((row) => ({
    store: row.store,
    proxy: row.proxy,
    checks: row.checks,
    success: row.success,
    successRate: row.successRate,
    p50Ms: row.p50Ms,
    p95Ms: row.p95Ms,
    statuses: row.samples.map((sample) => sample.status)
  }))))
}

void main()
