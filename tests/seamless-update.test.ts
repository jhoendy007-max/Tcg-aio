import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(join(process.cwd(), "src/main/auto-update.ts"), "utf8")
const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { build: Record<string, any> }

describe("seamless desktop updates (0.2.37)", () => {
  it("installs silently and relaunches", () => {
    expect(source).toMatch(/quitAndInstall\(true, true\)/)
    expect(source).toMatch(/autoInstallOnAppQuit = true/)
    expect(source).toMatch(/disableDifferentialDownload = false/)
  })
  it("downloads in the background once a newer release is found", () => {
    const check = source.slice(source.indexOf("async function check"), source.indexOf("async function download"))
    expect(check).toMatch(/void download\(\)/)
  })
  it("keeps the update identity unchanged so existing installs keep updating", () => {
    expect(pkg.build.appId).toBe("com.tcgaio.desktop")
    expect(pkg.build.win.artifactName).toBe("${productName}-Setup-${version}.${ext}")
    expect(pkg.build.nsis.differentialPackage).not.toBe(false)
    expect(pkg.build.publish.provider).toBe("github")
  })
})
