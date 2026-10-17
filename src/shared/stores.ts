import type { StoreId, StoreInfo } from "./types"

export const STORE_CATALOG: StoreInfo[] = [
  { id: "target", name: "Target", skuHint: "TCIN or product URL", implemented: true },
  { id: "walmart", name: "Walmart", skuHint: "Item ID or product URL", implemented: true },
  { id: "bestbuy", name: "Best Buy", skuHint: "SKU or product URL", implemented: true },
  { id: "pokemon-center", name: "Pokémon Center", skuHint: "SKU or product URL", implemented: true },
  { id: "amazon", name: "Amazon", skuHint: "ASIN or product URL", implemented: true },
  { id: "crunchyroll", name: "Crunchyroll", skuHint: "Product ID or URL", implemented: true },
  { id: "bandai", name: "Premium Bandai", skuHint: "Product code or p-bandai.com item URL", implemented: true },
  { id: "gamestop", name: "GameStop", skuHint: "Product URL or GameStop product id", implemented: true },
  { id: "barnes-noble", name: "Barnes & Noble", skuHint: "Product URL or ISBN", implemented: true },
  { id: "costco", name: "Costco", skuHint: "Product URL or Costco item number", implemented: true },
  { id: "sams", name: "Sam's Club", skuHint: "Product URL or Sam's Club item number", implemented: true },
  { id: "tcgplayer", name: "TCGplayer Direct", skuHint: "Product id or tcgplayer.com product URL", implemented: true }
]

export function storeName(id: StoreId): string {
  return STORE_CATALOG.find((store) => store.id === id)?.name ?? id
}

export function isStoreId(value: string): value is StoreId {
  return STORE_CATALOG.some((store) => store.id === value)
}
