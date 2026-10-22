import type { AioApi } from "../../shared/api"

declare global {
  interface Window {
    aio: AioApi
  }
}

export {}

declare module "*.png" {
  const src: string
  export default src
}
