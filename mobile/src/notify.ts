import * as Notifications from "expo-notifications"
import type { PhoneNotice } from "../../src/phone/protocol"

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true
  })
})

export async function ensureNotificationPermission(): Promise<void> {
  const current = await Notifications.getPermissionsAsync()
  if (current.granted) return
  await Notifications.requestPermissionsAsync()
}

export async function notify(notice: PhoneNotice): Promise<void> {
  const title = notice.kind === "success" ? "Checkout finished" : notice.kind === "paused" ? "Task needs you" : "Checkout failed"
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body: `${notice.storeName} · ${notice.sku}\n${notice.detail}`.slice(0, 240)
    },
    trigger: null
  })
}
