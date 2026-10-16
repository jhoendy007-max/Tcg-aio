import type { StoreId, StoreInfo } from "./types"

export const STORE_CATALOG: StoreInfo[] = [
  { id: "target", name: "Target", skuHint: "TCIN or product URL", implemented: true },
  { id: "walmart", name: "Walmart", skuHint: "Item ID or product URL", implemented: true },
  { id: "bestbuy", name: "Best Buy", skuHint: "SKU or product URL", implemented: true },
  { id: "pokemon-center", name: "Pokémon Center", skuHint: "SKU or product URL", implemented: true },
  { id: "amazon", name: "Amazon", skuHint: "ASIN or product URL", implemented: true },
  { id: "crunchyroll", name: "Crunchyroll", skuHint: "Product ID or URL", implemented: true },
  { id: "bandai", name: "Premium Bandai", skuHint: "Product code or p-bandai.com item URL", implemented: true }
]

export function storeName(id: StoreId): string {
  return STORE_CATALOG.find((store) => store.id === id)?.name ?? id
}

export function isStoreId(value: string): value is StoreId {
  return STORE_CATALOG.some((store) => store.id === value)
}
