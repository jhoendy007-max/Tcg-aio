import type { AioApi } from "../../shared/api"

declare global {
  interface Window {
    aio: AioApi
  }
}

export {}
