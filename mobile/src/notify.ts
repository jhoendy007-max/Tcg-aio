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
  const title = notice.kind === "success"
    ? "Checkout finished"
    : notice.kind === "tested"
      ? "Test finished"
      : notice.kind === "alert"
        ? "Restock match"
        : notice.kind === "challenge"
          ? "Solve a challenge"
          : notice.kind === "session"
            ? "Sign in again"
            : notice.kind === "drop"
              ? "Drop"
              : notice.kind === "health"
                ? "Daily report"
                : notice.kind === "paused"
                ? "Needs attention"
                : "Checkout failed"
  const price = typeof notice.price === "number" ? ` · $${notice.price.toFixed(2)}` : ""
  const image = notice.imageUrl?.startsWith("https://") ? notice.imageUrl : ""
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body: `${notice.storeName} · ${notice.sku}${price}\n${notice.detail}`.slice(0, 240),
      data: { url: notice.url ?? "", imageUrl: image },
      ...(image ? { attachments: [{ identifier: "product", url: image, type: "image" }] } : {})
    },
    trigger: null
  })
}
