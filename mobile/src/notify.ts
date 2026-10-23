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

/** 0.2.40: own high-priority channel so a challenge rings and vibrates even when other alerts are quiet. */
export const CHALLENGE_CHANNEL = "challenge"

export async function ensureChallengeChannel(): Promise<void> {
  try {
    await Notifications.setNotificationChannelAsync(CHALLENGE_CHANNEL, {
      name: "Challenge needs you",
      description: "A store check needs you. Tap to open it already loaded.",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      vibrationPattern: [0, 400, 200, 400],
      enableVibrate: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: false
    })
  } catch {
    // iOS and older Androids have no channels.
  }
}

export async function ensureNotificationPermission(): Promise<void> {
  await ensureChallengeChannel()
  const current = await Notifications.getPermissionsAsync()
  if (current.granted) return
  await Notifications.requestPermissionsAsync()
}

/** 0.2.40: sound settings mirrored from the PC (Settings > Discord > Sounds). */
let soundPrefs: { on: boolean; instock: string; success: string; failure: string } = { on: true, instock: "rise", success: "fanfare", failure: "drop" }
const SOUND_IDS = ["chime", "bell", "pulse", "rise", "fanfare", "drop", "buzz", "knock"]

export function setSoundPrefs(next: typeof soundPrefs | undefined): void {
  if (next) soundPrefs = next
}

function soundEvent(notice: PhoneNotice): "instock" | "success" | "failure" | null {
  if (notice.kind === "alert" && notice.inStock === true) return "instock"
  if (notice.kind === "success" || notice.kind === "tested") return "success"
  if (notice.kind === "failure") return "failure"
  return null
}

/**
 * Android fixes a channel's sound when the channel is created, so each event+sound pair gets
 * its own channel (e.g. "instock-rise"). The WAVs are generated, not recorded.
 */
async function eventChannel(event: "instock" | "success" | "failure"): Promise<string | null> {
  const sound = soundPrefs[event]
  if (!soundPrefs.on || !SOUND_IDS.includes(sound)) return null
  const id = `${event}-${sound}`
  try {
    await Notifications.setNotificationChannelAsync(id, {
      name: event === "instock" ? `In stock (${sound})` : event === "success" ? `Checkout success (${sound})` : `Checkout failed (${sound})`,
      importance: Notifications.AndroidImportance.HIGH,
      sound: `zzz_${sound}.wav`,
      vibrationPattern: event === "failure" ? [0, 120, 80, 120] : [0, 200]
    })
  } catch {
    return null
  }
  return id
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
  const challenge = notice.kind === "challenge"
  const event = soundEvent(notice)
  const channel = !challenge && event ? await eventChannel(event) : null
  await Notifications.scheduleNotificationAsync({
    content: {
      title: challenge ? `${notice.storeName}: challenge needs you` : notice.kind === "tested" ? `DRY RUN · ${title}` : title,
      body: challenge
        ? `${notice.sku} · Tap to open the check. The task resumes on its own when you clear it.`
        : `${notice.storeName} · ${notice.sku}${price}\n${notice.detail}`.slice(0, 240),
      data: { url: notice.url ?? "", imageUrl: image, challenge },
      ...(challenge ? { sound: "default", priority: Notifications.AndroidNotificationPriority.MAX, vibrate: [0, 400, 200, 400] } : {}),
      ...(image ? { attachments: [{ identifier: "product", url: image, type: "image" }] } : {})
    },
    trigger: challenge ? { channelId: CHALLENGE_CHANNEL } : channel ? { channelId: channel } : null
  })
}
