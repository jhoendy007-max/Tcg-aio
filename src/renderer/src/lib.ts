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
  idle: "Idle",
  monitoring: "Monitoring",
  in_stock: "In stock",
  adding_to_cart: "Adding to cart",
  checking_out: "Checking out",
  success: "Checked out",
  failed: "Failed",
  paused: "Paused",
  stopped: "Stopped",
  tested: "Tested",
  challenge: "Solve challenge"
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
