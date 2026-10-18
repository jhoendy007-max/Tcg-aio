export const SECTIONS = ["home", "tasks", "people", "clients", "settings"] as const
export type SectionId = (typeof SECTIONS)[number]

export type PeopleTab = "profiles" | "accounts" | "proxies"
export type SettingsTab = "general" | "logs" | "stores" | "phone" | "alerts" | "drops" | "stats" | "ship" | "autopilot" | "keeper" | "vault"
export type TaskTab = "" | "monitor" | "checkout"

export interface AppRoute {
  section: SectionId
  tab: string
}

const LEGACY: Record<string, AppRoute> = {
  monitors: { section: "tasks", tab: "monitor" },
  profiles: { section: "people", tab: "profiles" },
  accounts: { section: "people", tab: "accounts" },
  proxies: { section: "people", tab: "proxies" },
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

export function parseRoute(hash: string): AppRoute {
  const clean = hash.replace(/^#/, "").split("?")[0]
  const [head, rest] = clean.split("/")
  if (LEGACY[head]) return LEGACY[head]
  if (head === "home" || head === "") return { section: "home", tab: "" }
  if (head === "tasks") return { section: "tasks", tab: rest === "monitor" || rest === "checkout" ? rest : "" }
  if (head === "people") return { section: "people", tab: rest === "accounts" || rest === "proxies" ? rest : "profiles" }
  if (head === "clients") return { section: "clients", tab: "" }
  if (head === "settings") return { section: "settings", tab: rest || "general" }
  return { section: "home", tab: "" }
}

export function routeHash(section: SectionId, tab = ""): string {
  if (!tab || (section === "people" && tab === "profiles") || (section === "settings" && tab === "general")) return section === "home" ? "home" : section
  return `${section}/${tab}`
}
