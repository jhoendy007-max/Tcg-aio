import type { SavedPhoneLink } from "./client"

export interface PhoneBook {
  activePcId: string
  links: SavedPhoneLink[]
}

const MAX_PCS = 8

export function emptyBook(): PhoneBook {
  return { activePcId: "", links: [] }
}

export function bookFromLegacy(raw: unknown): PhoneBook {
  if (raw && typeof raw === "object" && Array.isArray((raw as PhoneBook).links)) {
    const book = raw as PhoneBook
    const links = book.links.filter(validLink).slice(0, MAX_PCS)
    const active = links.find((link) => link.pcId === book.activePcId) ?? links[0]
    return { activePcId: active?.pcId ?? "", links }
  }
  if (validLink(raw)) return { activePcId: raw.pcId, links: [raw] }
  return emptyBook()
}

export function upsertLink(book: PhoneBook, link: SavedPhoneLink): PhoneBook {
  if (!validLink(link)) return book
  const links = [link, ...book.links.filter((item) => item.pcId !== link.pcId)].slice(0, MAX_PCS)
  return { activePcId: link.pcId, links }
}

export function selectLink(book: PhoneBook, pcId: string): PhoneBook {
  if (!book.links.some((item) => item.pcId === pcId)) return book
  return { ...book, activePcId: pcId }
}

export function forgetPc(book: PhoneBook, pcId: string): PhoneBook {
  const links = book.links.filter((item) => item.pcId !== pcId)
  const activePcId = book.activePcId === pcId ? links[0]?.pcId ?? "" : book.activePcId
  const active = links.some((item) => item.pcId === activePcId) ? activePcId : links[0]?.pcId ?? ""
  return { activePcId: active, links }
}

export function activeLink(book: PhoneBook): SavedPhoneLink | null {
  return book.links.find((item) => item.pcId === book.activePcId) ?? book.links[0] ?? null
}

function validLink(value: unknown): value is SavedPhoneLink {
  if (!value || typeof value !== "object") return false
  const link = value as SavedPhoneLink
  return Boolean(link.token && link.deviceId && link.pcId && link.host && typeof link.port === "number")
}
