import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(__dirname, "..")
const skip = new Set(["node_modules", ".git", "out", "release", "dist", "build", ".cline-home", "docs"])

function files(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...files(full))
    else if (/\.(ts|tsx|js|mjs|cjs|json|html|md|yml|yaml|sh|ps1|nsh)$/.test(name)) found.push(full)
  }
  return found
}

// A Clawbrowser key is clawbrowser_ followed by a long token. Sellers ship one build
// to many buyers, so a key in the repo is a key in every buyer's install.
const KEY = /clawbrowser_[A-Za-z0-9_-]{12,}/

// The app asks clawctl for a path only. It never holds an API key of its own.
const ENV_KEY = /CLAWBROWSER_API_KEY\s*[:=]\s*["'`]?(?!<|\$|your|YOUR|\$\{)[A-Za-z0-9_-]{12,}/

describe("no Clawbrowser key is baked into the build", () => {
  it("no tracked file contains a key", () => {
    const hits: string[] = []
    for (const file of files(root)) {
      const text = readFileSync(file, "utf8")
      if (KEY.test(text) || ENV_KEY.test(text)) hits.push(relative(root, file))
    }
    expect(hits, hits.join(", ")).toEqual([])
  })

  it("the launcher reads only the clawctl path", () => {
    const source = readFileSync(join(root, "src/browser/claw-launch.ts"), "utf8")
    expect(source.includes("CLAWBROWSER_API_KEY")).toBe(false)
    expect(source.includes("CLAWCTL_PATH")).toBe(true)
  })
})
