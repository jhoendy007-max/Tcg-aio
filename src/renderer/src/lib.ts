import type { Result, TaskStatus } from "../../shared/types"

export async function unwrap<T>(pending: Promise<Result<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  idle: "Waiting",
  monitoring: "Monitoring",
  in_stock: "In stock",
  adding_to_cart: "Carting",
  checking_out: "Checking out",
  success: "Success",
  failed: "Declined",
  paused: "Waiting",
  stopped: "Stopped",
  tested: "Success",
  challenge: "Waiting",
  in_queue: "In queue"
}

const STATUS_LABEL_ES: Record<TaskStatus, string> = {
  idle: "En espera",
  monitoring: "Vigilando",
  in_stock: "Hay stock",
  adding_to_cart: "Al carrito",
  checking_out: "Pagando",
  success: "Éxito",
  failed: "Rechazado",
  paused: "En espera",
  stopped: "Detenido",
  tested: "Éxito",
  challenge: "En espera",
  in_queue: "En cola"
}

export function statusLabel(status: TaskStatus, lang: "en" | "es"): string {
  return lang === "es" ? STATUS_LABEL_ES[status] : STATUS_LABEL[status]
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
