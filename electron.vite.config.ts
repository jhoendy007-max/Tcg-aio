import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import { normalizeLicenseKey, normalizeLicenseUrl } from "./scripts/license-build-values.mjs"

function bakedLicense(kind: "url" | "key"): string {
  const raw = kind === "url" ? process.env.TCGAIO_LICENSE_URL : process.env.TCGAIO_LICENSE_PUBLIC_KEY
  if (!raw?.trim()) return ""
  return kind === "url" ? normalizeLicenseUrl(raw) : normalizeLicenseKey(raw)
}

const licenseDefine = {
  "process.env.TCGAIO_LICENSE_URL": JSON.stringify(bakedLicense("url")),
  "process.env.TCGAIO_LICENSE_PUBLIC_KEY": JSON.stringify(bakedLicense("key"))
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["undici"] })],
    define: licenseDefine
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          "signin-bar": resolve(__dirname, "src/preload/signin-bar.ts")
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    define: licenseDefine
  }
})
