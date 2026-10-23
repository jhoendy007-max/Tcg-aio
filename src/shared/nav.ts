export const SECTIONS = ["home", "tasks", "profiles", "proxies", "accounts", "aco", "settings"] as const
export type SectionId = (typeof SECTIONS)[number]

export type SettingsTab = "general" | "advanced" | "discord" | "imap" | "sounds" | "notifications" | "logs" | "stores" | "phone" | "alerts" | "drops" | "stats" | "ship" | "autopilot" | "keeper" | "vault"
export type TaskTab = "" | "monitor" | "checkout"

export interface AppRoute {
  section: SectionId
  tab: string
}

const LEGACY: Record<string, AppRoute> = {
  monitors: { section: "tasks", tab: "monitor" },
  profiles: { section: "profiles", tab: "" },
  accounts: { section: "accounts", tab: "" },
  proxies: { section: "proxies", tab: "" },
  clients: { section: "aco", tab: "" },
  people: { section: "profiles", tab: "" },
  logs: { section: "settings", tab: "logs" },
  keeper: { section: "settings", tab: "keeper" },
  vault: { section: "settings", tab: "vault" },
  drops: { section: "settings", tab: "drops" },
  stats: { section: "settings", tab: "stats" },
  ship: { section: "settings", tab: "ship" },
  alerts: { section: "settings", tab: "alerts" },
  autopilot: { section: "settings", tab: "autopilot" },
  phone: { section: "settings", tab: "phone" },
  stores: { section: "settings", tab: "stores" }
}

const SETTINGS_TABS = new Set(["general", "advanced", "discord", "imap", "sounds", "notifications", "logs", "stores", "phone", "alerts", "drops", "stats", "ship", "autopilot", "keeper", "vault"])

export function parseRoute(hash: string): AppRoute {
  const clean = hash.replace(/^#/, "").split("?")[0]
  const [head, rest] = clean.split("/")
  if (head === "people") {
    if (rest === "accounts") return { section: "accounts", tab: "" }
    if (rest === "proxies") return { section: "proxies", tab: "" }
    return { section: "profiles", tab: "" }
  }
  if (LEGACY[head]) return LEGACY[head]
  if (head === "home" || head === "") return { section: "home", tab: "" }
  if (head === "tasks") return { section: "tasks", tab: rest === "monitor" || rest === "checkout" ? rest : "" }
  if (head === "profiles") return { section: "profiles", tab: "" }
  if (head === "proxies") return { section: "proxies", tab: "" }
  if (head === "accounts") return { section: "accounts", tab: "" }
  if (head === "aco") return { section: "aco", tab: rest === "advanced" ? "advanced" : "" }
  if (head === "settings") return { section: "settings", tab: SETTINGS_TABS.has(rest) ? rest : "general" }
  return { section: "home", tab: "" }
}

export function routeHash(section: SectionId, tab = ""): string {
  if (section === "home") return "home"
  if (section === "settings" && (!tab || tab === "general")) return "settings"
  if (section === "aco" && tab === "advanced") return "aco/advanced"
  if (!tab) return section
  return `${section}/${tab}`
}
