export const colors = {
  bg: "#070a1f",
  sidebar: "#090b10",
  card: "rgba(255,255,255,0.06)",
  card2: "#10141b",
  line: "rgba(167,139,250,0.22)",
  text: "#f2f5f8",
  muted: "#a3a8c9",
  accent: "#8b5cf6",
  accentInk: "#ffffff",
  ok: "#3cba8b",
  warn: "#e0a045",
  danger: "#e25b5b",
  wash: "#1a2436"
}

const ACCENT: Record<"dark" | "light", Record<string, [string, string]>> = {
  dark: {
    gold: ["#8b5cf6", "#ffffff"],
    blue: ["#8b5cf6", "#ffffff"],
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
  const key = brand?.accent && ACCENT[mode][brand.accent] ? brand.accent : "blue"
  const accent = ACCENT[mode][key]
  const wash = mode === "light" ? "#f3ead8" : key === "gold" ? "#2a2418" : key === "green" ? "#10241c" : key === "rose" ? "#2a1820" : "#1a2436"
  if (mode === "dark") return { ...colors, accent: accent[0], accentInk: accent[1], wash }
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

export function isActive(status: string): boolean {
  return status === "monitoring" || status === "in_stock" || status === "adding_to_cart" || status === "checking_out" || status === "challenge" || status === "in_queue"
}
