import type { Settings } from "../../shared/types"

export function applyTheme(settings: Pick<Settings, "theme" | "accent">): void {
  document.documentElement.dataset.theme = settings.theme
  document.documentElement.dataset.accent = settings.accent
}
