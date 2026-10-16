import * as SecureStore from "expo-secure-store"
import type { SavedPhoneLink } from "../../src/phone/client"

const KEY = "tcgaio.phone.link"

export async function loadLink(): Promise<SavedPhoneLink | null> {
  const raw = await SecureStore.getItemAsync(KEY)
  if (!raw) return null
  const parsed = JSON.parse(raw) as SavedPhoneLink
  if (!parsed.token || !parsed.pcId || !parsed.host || !parsed.port) return null
  return parsed
}

export async function saveLink(link: SavedPhoneLink): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(link))
}

export async function clearLink(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY)
}
