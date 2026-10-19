import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    {
      name: "external-node-sqlite",
      resolveId(id) {
        if (id === "node:sqlite" || id === "sqlite") return "\0node-sqlite"
      },
      load(id) {
        if (id !== "\0node-sqlite") return null
        return "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); export const { DatabaseSync } = require('node:sqlite');"
      }
    }
  ],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000
  }
})
