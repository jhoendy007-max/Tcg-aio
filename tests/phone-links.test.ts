import { describe, expect, it } from "vitest"
import { activeLink, bookFromLegacy, forgetPc, selectLink, upsertLink, type PhoneBook } from "../src/phone/links"
import type { SavedPhoneLink } from "../src/phone/client"

function link(pcId: string, name: string): SavedPhoneLink {
  return { token: `token-${pcId}`, deviceId: `device-${pcId}`, pcId, pcName: name, host: "127.0.0.1", port: 17321 }
}

describe("phone links", () => {
  it("keeps several PCs and forgets only the one that was removed", () => {
    const legacy = bookFromLegacy(link("pc-a", "Desk"))
    expect(activeLink(legacy)?.pcName).toBe("Desk")
    const both = upsertLink(legacy, link("pc-b", "Shop"))
    expect(both.links.map((item) => item.pcName)).toEqual(["Shop", "Desk"])
    expect(activeLink(both)?.pcId).toBe("pc-b")
    const back = selectLink(both, "pc-a")
    expect(activeLink(back)?.pcName).toBe("Desk")
    const forgot = forgetPc(back, "pc-a")
    expect(forgot.links.map((item) => item.pcId)).toEqual(["pc-b"])
    expect(activeLink(forgot)?.pcName).toBe("Shop")
    expect(forgetPc(forgot, "pc-b")).toEqual({ activePcId: "", links: [] })
  })

  it("reads a saved book and a single older pairing", () => {
    const book: PhoneBook = { activePcId: "pc-b", links: [link("pc-a", "Desk"), link("pc-b", "Shop")] }
    expect(activeLink(bookFromLegacy(book))?.pcName).toBe("Shop")
    expect(bookFromLegacy({ token: "" })).toEqual({ activePcId: "", links: [] })
  })
})