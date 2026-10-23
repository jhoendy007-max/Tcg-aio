/** Stock colour rules shared by the desktop and the phone: green and red only ever mean stock. */
export type StockState = "in" | "out" | ""

const IN_RE = /\b(in stock|back in stock|available now|stock found|restock(ed)?|purchasable)\b/i
const OUT_RE = /\b(out of stock|sold out|oos|not available|unavailable|no stock)\b/i

export function stockOfLine(message: string): StockState {
  if (!message) return ""
  if (OUT_RE.test(message)) return "out"
  if (IN_RE.test(message)) return "in"
  return ""
}

/** Stock reading for a task: in-stock phases are green, a watching monitor whose last reading was out of stock is red. */
export function stockOfTask(task: { status: string; logs?: Array<{ message: string }> }): StockState {
  if (task.status === "in_stock" || task.status === "adding_to_cart" || task.status === "checking_out") return "in"
  if (task.status !== "monitoring" && task.status !== "in_queue") return ""
  const logs = task.logs ?? []
  for (let index = logs.length - 1; index >= 0 && index >= logs.length - 6; index -= 1) {
    const state = stockOfLine(logs[index].message)
    if (state) return state
  }
  return ""
}
