import { describe, expect, it } from "vitest"
import { parseRoute, routeHash } from "../src/shared/nav"

describe("settings top bar routes", () => {
  it.each(["discord", "imap", "phone", "sounds", "notifications", "alerts", "drops"])("#settings/%s keeps its tab", (tab) => {
    expect(parseRoute(`#settings/${tab}`)).toEqual({ section: "settings", tab })
    expect(parseRoute(`#${routeHash("settings", tab)}`).tab).toBe(tab)
  })
  it("unknown tab still falls back to general", () => {
    expect(parseRoute("#settings/nope").tab).toBe("general")
  })
})
