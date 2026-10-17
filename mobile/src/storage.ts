import * as SecureStore from "expo-secure-store"
import type { SavedPhoneLink } from "../../src/phone/client"
import { activeLink, bookFromLegacy, forgetPc, selectLink, upsertLink, type PhoneBook } from "../../src/phone/links"

const KEY = "tcgaio.phone.links"
const LEGACY = "tcgaio.phone.link"

export async function loadBook(): Promise<PhoneBook> {
  const raw = await SecureStore.getItemAsync(KEY)
  if (raw) return bookFromLegacy(JSON.parse(raw) as unknown)
  const legacy = await SecureStore.getItemAsync(LEGACY)
  return bookFromLegacy(legacy ? JSON.parse(legacy) as unknown : null)
}

export async function saveBook(book: PhoneBook): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(book))
}

export async function loadLink(): Promise<SavedPhoneLink | null> {
  return activeLink(await loadBook())
}

export async function saveLink(link: SavedPhoneLink): Promise<PhoneBook> {
  const book = upsertLink(await loadBook(), link)
  await saveBook(book)
  return book
}

export async function selectPc(pcId: string): Promise<PhoneBook> {
  const book = selectLink(await loadBook(), pcId)
  await saveBook(book)
  return book
}

export async function forgetPcLink(pcId: string): Promise<PhoneBook> {
  const book = forgetPc(await loadBook(), pcId)
  await saveBook(book)
  return book
}

export async function clearLink(): Promise<PhoneBook> {
  const current = await loadBook()
  return forgetPcLink(activeLink(current)?.pcId ?? "")
}
