import { describe, expect, it } from "vitest"
import { UPDATE_CHECK_MS, promptVisible, runningTaskWarning, shortenNotes, tasksAreRunning, updateInstallLabel } from "../src/shared/update-prompt"

describe("update prompt", () => {
  it("shows a new version until Later, and warns while tasks are running", () => {
    expect(UPDATE_CHECK_MS).toBe(30 * 60 * 1000)
    expect(promptVisible("available", false)).toBe(true)
    expect(promptVisible("downloaded", false)).toBe(true)
    expect(promptVisible("ready", false)).toBe(true)
    expect(promptVisible("available", true)).toBe(false)
    expect(promptVisible("current", false)).toBe(false)
    expect(promptVisible("error", false)).toBe(false)
    expect(tasksAreRunning([{ status: "idle" }, { status: "checking_out" }])).toBe(true)
    expect(tasksAreRunning([{ status: "idle" }, { status: "success" }])).toBe(false)
    expect(runningTaskWarning()).toMatch(/stops them/)
    expect(updateInstallLabel("downloading", 40)).toBe("Downloading 40%")
    expect(updateInstallLabel("downloaded", 100)).toBe("Install now")
    expect(shortenNotes("")).toBe("A new version is available.")
    expect(shortenNotes("x".repeat(20), 8)).toBe("xxxxxxxx…")
  })
})
