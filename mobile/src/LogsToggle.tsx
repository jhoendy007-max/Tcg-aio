import * as SecureStore from "expo-secure-store"
import { useEffect, useState, type ReactNode } from "react"
import { Pressable, Text, View } from "react-native"
import { LOGS_PREF_KEY, logsButtonLabel, readLogsOpen, writeLogsOpen } from "../../src/shared/logs-pref"

let remembered: boolean | null = null
const listeners = new Set<(open: boolean) => void>()

/** One remembered "logs open" switch for every log view on the phone. Closed by default. */
export function useLogsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(remembered ?? false)
  useEffect(() => {
    listeners.add(setOpen)
    if (remembered === null) {
      void SecureStore.getItemAsync(LOGS_PREF_KEY).then((raw) => {
        remembered = readLogsOpen(raw)
        listeners.forEach((listener) => listener(remembered!))
      }).catch(() => undefined)
    }
    return () => { listeners.delete(setOpen) }
  }, [])
  const change = (next: boolean) => {
    remembered = next
    listeners.forEach((listener) => listener(next))
    void SecureStore.setItemAsync(LOGS_PREF_KEY, writeLogsOpen(next)).catch(() => undefined)
  }
  return [open, change]
}

export function LogsToggle({ count, children, color = "#c4b5fd" }: { count: number; children: ReactNode; color?: string }) {
  const [open, setOpen] = useLogsOpen()
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: "rgba(167,139,250,0.35)", backgroundColor: "rgba(255,255,255,0.06)" }}
      >
        <Text style={{ color, fontWeight: "700", fontSize: 13 }}>{open ? "▾ " : "▸ "}{logsButtonLabel(open, count)}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  )
}
