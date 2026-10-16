export const colors = {
  bg: "#14161b",
  sidebar: "#0c0d10",
  card: "#1b1e25",
  card2: "#12141a",
  line: "#2e333d",
  text: "#e7ebf2",
  muted: "#9aa3b5",
  accent: "#e0b15a",
  accentInk: "#1c1508",
  ok: "#3cba8b",
  warn: "#e0a045",
  danger: "#e25b5b"
}

export const STATUS_LABEL: Record<string, string> = {
  idle: "Idle",
  monitoring: "Monitoring",
  in_stock: "In stock",
  adding_to_cart: "Adding to cart",
  checking_out: "Checking out",
  success: "Success",
  failed: "Failed",
  paused: "Paused",
  stopped: "Stopped",
  tested: "Tested"
}

export function isActive(status: string): boolean {
  return status === "monitoring" || status === "in_stock" || status === "adding_to_cart" || status === "checking_out"
}
