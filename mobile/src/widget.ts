import { NativeModules } from "react-native"

export function updateWidget(wins: number, active: number): void {
  const widget = NativeModules.TCGAIOWidget as { update?: (wins: number, active: number) => void } | undefined
  widget?.update?.(Math.max(0, Math.round(wins)), Math.max(0, Math.round(active)))
}
