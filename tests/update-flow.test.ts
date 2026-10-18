import { describe, expect, it } from "vitest"
import { fetchLatestRelease, PRIVATE_RELEASE_MESSAGE } from "../src/engine/releases"
import { applyProgress, canInstall, DEV_DOWNLOAD_MESSAGE, DEV_INSTALL_MESSAGE, feedPrivacy, markFailed, markReady, releaseDecision, startChecking, startDownload } from "../src/engine/update-flow"
import { updateStatusText } from "../src/shared/update-status"
import type { HttpClient } from "../src/engine/http"
import type { UpdateStatus } from "../src/shared/types"
import { APP_VERSION } from "../src/shared/version"

function idle(): UpdateStatus {
  return { current: APP_VERSION, status: "idle", version: null, notes: "", phoneVersion: null, error: "", hasToken: false, percent: null }
}

function http(status: number, body: string, seen: { authorization?: string } = {}): HttpClient {
  return {
    async request(input) {
      seen.authorization = input.headers?.authorization
      return { status, body, headers: {} }
    }
  }
}

const releaseBody = JSON.stringify([
  {
    tag_name: "v9.9.9-beta",
    draft: false,
    body: "Newer desktop",
    assets: [{ name: "latest.yml" }, { name: "TCGAIO-Setup-9.9.9.exe" }, { name: "TCGAIO-Phone-9.9.9.apk" }]
  }
])

describe("update flow", () => {
  it("moves from checking to up to date, available, downloading, and ready", () => {
    const checking = startChecking(idle())
    expect(checking.status).toBe("checking")
    expect(updateStatusText(checking)).toMatch(/Checking/)

    const same = releaseDecision(checking, { version: APP_VERSION, notes: "same", exe: "TCGAIO-Setup.exe", apk: null }, APP_VERSION)
    expect(same.status).toBe("current")
    expect(same.version).toBe(APP_VERSION)
    expect(updateStatusText(same)).toMatch(/up to date/)

    const apkOnly = releaseDecision(checking, { version: "9.9.9", notes: "phone", exe: null, apk: "app.apk" }, APP_VERSION)
    expect(apkOnly.status).toBe("current")
    expect(apkOnly.phoneVersion).toBe("9.9.9")

    const available = releaseDecision(checking, { version: "9.9.9-beta", notes: "Newer desktop", exe: "TCGAIO-Setup-9.9.9.exe", apk: "app.apk" }, APP_VERSION)
    expect(available.status).toBe("available")
    expect(available.version).toBe("9.9.9-beta")
    expect(updateStatusText(available)).toMatch(/available/)

    const dev = startDownload(available, false)
    expect(dev.proceed).toBe(false)
    expect(dev.status.error).toBe(DEV_DOWNLOAD_MESSAGE)
    expect(updateStatusText(dev.status)).toBe(DEV_DOWNLOAD_MESSAGE)

    const early = startDownload(idle(), true)
    expect(early.proceed).toBe(false)

    const downloading = startDownload(available, true)
    expect(downloading.proceed).toBe(true)
    expect(downloading.status.status).toBe("downloading")
    const progressed = applyProgress(downloading.status, 41.6)
    expect(progressed.percent).toBe(42)
    expect(updateStatusText(progressed)).toMatch(/42%/)
    expect(applyProgress(progressed, 140).percent).toBe(100)
    const ready = markReady(progressed)
    expect(ready.status).toBe("downloaded")
    expect(ready.percent).toBe(100)
    expect(updateStatusText(ready)).toMatch(/Restart and install/)
    expect(canInstall(ready, true).ok).toBe(true)
    const devInstall = canInstall(ready, false)
    expect(devInstall.ok).toBe(false)
    if (!devInstall.ok) expect(devInstall.status.error).toBe(DEV_INSTALL_MESSAGE)
    expect(canInstall(available, true).ok).toBe(false)
  })

  it("redacts a token from an updater error and keeps a public feed public", () => {
    const failed = markFailed(idle(), "download failed for github_pat_secret_value and ghp_othersecret")
    expect(failed.status).toBe("error")
    expect(failed.error).not.toContain("secret")
    expect(failed.error).toContain("[token]")
    expect(feedPrivacy("")).toEqual({ private: false })
    expect(feedPrivacy("  github_pat_abc  ")).toEqual({ private: true, token: "github_pat_abc" })
  })

  it("reads a public GitHub release without a token and asks for one only when access is denied", async () => {
    const open = { authorization: "present" }
    const release = await fetchLatestRelease(http(200, releaseBody, open), "")
    expect(open.authorization).toBeUndefined()
    expect(release?.exe).toBe("TCGAIO-Setup-9.9.9.exe")
    expect(release?.version).toBe("9.9.9-beta")

    const authed = { authorization: "" }
    await fetchLatestRelease(http(200, releaseBody, authed), "github_pat_saved")
    expect(authed.authorization).toBe("Bearer github_pat_saved")

    await expect(fetchLatestRelease(http(401, "", {}), "")).rejects.toThrow(PRIVATE_RELEASE_MESSAGE)
    await expect(fetchLatestRelease(http(403, "bad", {}), "github_pat_nope")).rejects.toThrow(/rejected the token/)
    await expect(fetchLatestRelease(http(403, "bad", {}), "github_pat_nope")).rejects.toThrow(/Contents: Read/)
  })
})
