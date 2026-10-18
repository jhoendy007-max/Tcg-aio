import { describe, expect, it } from "vitest"
import { decidePhoneUpdate, emptyPhoneUpdate, expectedApkName, phoneDownloadProgress, phoneUpdateFailed, phoneUpdateReady, phoneUpdateText, readPhoneReleases, startPhoneCheck, startPhoneDownload, versionCodeFrom } from "../src/shared/phone-update"

const body = JSON.stringify([
  { tag_name: "v0.2.22-beta", draft: false, body: "Current", assets: [{ name: "TCGAIO-Phone-0.2.22.apk", browser_download_url: "https://github.com/jhoendy007-max/Tcg-aio/releases/download/v0.2.22-beta/TCGAIO-Phone-0.2.22.apk" }] },
  { tag_name: "v0.2.23-beta", draft: false, body: "Queue fixes", assets: [{ name: "latest.yml" }, { name: "TCGAIO-Phone-0.2.23.apk", browser_download_url: "https://github.com/jhoendy007-max/Tcg-aio/releases/download/v0.2.23-beta/TCGAIO-Phone-0.2.23.apk" }] },
  { tag_name: "v0.2.24-beta", draft: true, body: "hidden", assets: [{ name: "TCGAIO-Phone-0.2.24.apk", browser_download_url: "https://example.com/nope.apk" }] }
])

describe("phone updates", () => {
  it("walks checking, up to date, available, downloading, and ready", () => {
    const idle = emptyPhoneUpdate("0.2.22")
    const checking = startPhoneCheck(idle)
    expect(phoneUpdateText(checking)).toMatch(/Checking/)
    const releases = readPhoneReleases(body)
    expect(releases.map((release) => release.apkName)).toEqual(["TCGAIO-Phone-0.2.22.apk", "TCGAIO-Phone-0.2.23.apk"])
    const same = decidePhoneUpdate(checking, releases.filter((release) => release.version.startsWith("0.2.22")), "0.2.22")
    expect(same.phase).toBe("current")
    expect(phoneUpdateText(same)).toMatch(/up to date/)
    const available = decidePhoneUpdate(checking, releases, "0.2.22")
    expect(available.phase).toBe("available")
    expect(available.version).toBe("0.2.23-beta")
    expect(available.notes).toContain("Queue")
    expect(available.apkName).toBe(expectedApkName("0.2.23"))
    const early = startPhoneDownload(idle)
    expect(early.phase).toBe("error")
    const downloading = startPhoneDownload(available)
    expect(downloading.phase).toBe("downloading")
    const progressed = phoneDownloadProgress(downloading, 41.2)
    expect(progressed.percent).toBe(41)
    expect(phoneUpdateText(progressed)).toMatch(/41%/)
    const ready = phoneUpdateReady(progressed)
    expect(ready.phase).toBe("ready")
    expect(phoneUpdateText(ready)).toMatch(/ready to install/)
    const failed = phoneUpdateFailed(ready, "installer blocked")
    expect(failed.phase).toBe("error")
    expect(failed.error).toBe("installer blocked")
  })

  it("bumps Android versionCode with the app version", () => {
    expect(versionCodeFrom("0.2.22")).toBe(222)
    expect(versionCodeFrom("0.2.23-beta")).toBe(223)
    expect(versionCodeFrom("0.2.23-beta")).toBeGreaterThan(versionCodeFrom("0.2.22"))
    expect(expectedApkName("0.2.22-beta")).toBe("TCGAIO-Phone-0.2.22.apk")
  })
})
