/**
 * Checks the Clawbrowser wiring on this PC: clawctl is reachable, a profile
 * starts, its CDP endpoint answers, and a page request comes back.
 * Run with `npm run verify:claw`. No API key is read or printed here.
 */
import { ClawHttp } from "./claw-http"
import { clawLaunch, parseEndpoint } from "./claw-launch"

const url = process.argv[2] ?? "https://example.com"

async function main(): Promise<void> {
  const profile = "tcgaio-verify"
  console.log(`Starting Clawbrowser profile ${profile}...`)
  const browser = await clawLaunch({ profile, url })
  console.log(`CDP endpoint: ${parseEndpoint(browser.endpoint) ?? browser.endpoint}`)

  const http = new ClawHttp()
  const response = await http.request({ method: "GET", url, partition: "persist:account-verify" })
  console.log(`${url} -> HTTP ${response.status}, ${response.body.length} bytes`)

  await http.closeAll()
  await browser.close({ stopProfile: true })
  console.log("Clawbrowser is wired up.")
}

main().catch((err: unknown) => {
  console.error(`Clawbrowser check failed: ${err instanceof Error ? err.message : String(err)}`)
  console.error("Install clawctl, save the API key with `clawctl config set --api-key`, and put clawctl on PATH or set CLAWCTL_PATH.")
  process.exit(1)
})
