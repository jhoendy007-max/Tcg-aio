import { describe, expect, it } from "vitest"
import { logsButtonLabel, readLogsOpen, writeLogsOpen } from "../src/shared/logs-pref"

describe("phone logs toggle", () => {
  it("starts collapsed and remembers the choice", () => {
    expect(readLogsOpen(null)).toBe(false)
    expect(readLogsOpen(undefined)).toBe(false)
    expect(readLogsOpen(writeLogsOpen(true))).toBe(true)
    expect(readLogsOpen(writeLogsOpen(false))).toBe(false)
  })
  it("labels the button", () => {
    expect(logsButtonLabel(false, 4)).toBe("Logs (4)")
    expect(logsButtonLabel(true, 0)).toBe("Hide logs")
  })
})
