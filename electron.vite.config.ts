import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"

const licenseDefine = {
  "process.env.TCGAIO_LICENSE_URL": JSON.stringify((process.env.TCGAIO_LICENSE_URL ?? "").trim()),
  "process.env.TCGAIO_LICENSE_PUBLIC_KEY": JSON.stringify((process.env.TCGAIO_LICENSE_PUBLIC_KEY ?? "").trim())
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["undici"] })],
    define: licenseDefine
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    define: licenseDefine
  }
})
