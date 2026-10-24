import { describe, expect, it } from "vitest"
import { pageShowsStoreError, signInRejectedMessage, storeSignInUrl } from "../src/engine/session-care"

describe("Target sign-in window help (0.2.43)", () => {
  it("recognises Target's own error banner and nothing else", () => {
    expect(pageShowsStoreError("target", "Sign in\nSomething went wrong on our end. You can try again later or send a report")).toBe(true)
    expect(pageShowsStoreError("target", "Sign in with your email")).toBe(false)
    expect(pageShowsStoreError("walmart", "Something went wrong on our end")).toBe(false)
  })
  it("opens Target sign-in in the default browser and other stores at their home page", () => {
    expect(storeSignInUrl("target")).toBe("https://www.target.com/login")
    expect(storeSignInUrl("walmart")).toBe("https://www.walmart.com/")
  })
  it("explains the fallback in English and Spanish without blaming the password", () => {
    expect(signInRejectedMessage("en").detail).toMatch(/Session-Sync/)
    expect(signInRejectedMessage("es").detail).toMatch(/Session-Sync/)
    expect(signInRejectedMessage("en").browser).toBe("Open in my browser")
  })
  it("adds no bot-check solving or fingerprinting", () => {
    const text = JSON.stringify([signInRejectedMessage("en"), signInRejectedMessage("es")]).toLowerCase()
    for (const banned of ["solve", "bypass", "fingerprint", "spoof"]) expect(text).not.toContain(banned)
  })
})
