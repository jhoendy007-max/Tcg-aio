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
  danger: "#e25b5b",
  wash: "#2a2418"
}

const ACCENT: Record<"dark" | "light", Record<string, [string, string]>> = {
  dark: {
    gold: ["#e0b15a", "#1c1508"],
    blue: ["#79a6f5", "#0d1828"],
    green: ["#3cba8b", "#062018"],
    rose: ["#e07a8a", "#2a1014"]
  },
  light: {
    gold: ["#8d6416", "#fffaf0"],
    blue: ["#1f5fbf", "#f5f9ff"],
    green: ["#0f7a4b", "#f3fff8"],
    rose: ["#a33b52", "#fff6f8"]
  }
}

export function palette(brand?: { theme?: "dark" | "light"; accent?: string }): typeof colors {
  const mode = brand?.theme === "light" ? "light" : "dark"
  const accent = ACCENT[mode][brand?.accent ?? "gold"] ?? ACCENT[mode].gold
  if (mode === "dark") return { ...colors, accent: accent[0], accentInk: accent[1] }
  return {
    bg: "#f4f1ea",
    sidebar: "#fffdf8",
    card: "#ffffff",
    card2: "#f7f4ee",
    line: "#e4ddd0",
    text: "#1c1915",
    muted: "#6d655b",
    accent: accent[0],
    accentInk: accent[1],
    ok: "#0f7a4b",
    warn: "#8a5a10",
    danger: "#a12626",
    wash: "#f3ead8"
  }
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
  tested: "Tested",
  challenge: "Solve challenge",
  in_queue: "In queue"
}

export function isActive(status: string): boolean {
  return status === "monitoring" || status === "in_stock" || status === "adding_to_cart" || status === "checking_out" || status === "challenge" || status === "in_queue"
}
