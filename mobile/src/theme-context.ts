import { createContext, useContext } from "react"
import { colors } from "./theme"

export type ThemeBag = { colors: typeof colors; styles: Record<string, object> }
export const ThemeContext = createContext<ThemeBag>({ colors, styles: {} })
export function useTheme(): ThemeBag {
  return useContext(ThemeContext)
}
