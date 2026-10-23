import { describe, expect, it } from "vitest"
import { featuresForPlan, grantFeatures } from "../src/shared/entitlements"
import { parseRoute } from "../src/shared/nav"

describe("feature list", () => {
  it("gives the owner every feature and keeps ACO when a grant has no list", () => {
    expect(grantFeatures({ role: "owner", email: "someone@example.com", features: [] })).toEqual(["aco"])
    expect(grantFeatures({ role: "user", email: "jhoendy007@gmail.com", features: [] })).toEqual(["aco"])
    expect(grantFeatures({ role: "user" })).toEqual(["aco"])
    expect(grantFeatures({ role: "user", features: [] })).toEqual([])
    expect(grantFeatures({ role: "user", features: ["aco"] })).toEqual(["aco"])
    expect(featuresForPlan("standard")).toEqual([])
    expect(featuresForPlan("aco")).toEqual(["aco"])
  })

  it("opens Profiles, Proxies, Accounts, and ACO as their own sections", () => {
    expect(parseRoute("#profiles").section).toBe("profiles")
    expect(parseRoute("#proxies").section).toBe("proxies")
    expect(parseRoute("#accounts").section).toBe("accounts")
    expect(parseRoute("#aco").section).toBe("aco")
    expect(parseRoute("#aco/advanced").tab).toBe("advanced")
    expect(parseRoute("#people/proxies").section).toBe("proxies")
    expect(parseRoute("#settings").tab).toBe("general")
  })
})
