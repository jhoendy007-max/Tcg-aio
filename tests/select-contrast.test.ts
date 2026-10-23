import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

function luminance(hex: string): number {
  const value = hex.replace("#", "")
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function optionColors(css: string): { background: string; color: string } {
  const rule = css.match(/select option,\s*[^{]*select optgroup\s*\{([^}]*)\}/)
  expect(rule, "a select option/optgroup rule").not.toBeNull()
  const body = rule![1]
  return {
    background: body.match(/background-color:\s*(#[0-9a-f]{6})/i)![1],
    color: body.match(/(?:^|;)\s*color:\s*(#[0-9a-f]{6})/i)![1]
  }
}

describe("native dropdown lists stay readable (0.2.35)", () => {
  it("desktop: dark color-scheme and high-contrast option colours", () => {
    const css = readFileSync(join(__dirname, "../src/renderer/src/styles.css"), "utf8")
    expect(css).toMatch(/:root:not\(\[data-theme="light"\]\) select \{ color-scheme: dark; \}/)
    const { background, color } = optionColors(css.slice(css.indexOf("0.2.35: readable native dropdowns")))
    expect(luminance(background)).toBeLessThan(0.05)
    expect(contrast(background, color)).toBeGreaterThanOrEqual(7)
  })

  it("admin website: dark color-scheme and high-contrast option colours", () => {
    const html = readFileSync(join(__dirname, "../license-server/admin.html"), "utf8")
    expect(html).toMatch(/color-scheme: dark/)
    const { background, color } = optionColors(html.slice(html.indexOf("readable native dropdown lists")))
    expect(contrast(background, color)).toBeGreaterThanOrEqual(7)
  })
})
