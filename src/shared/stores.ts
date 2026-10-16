import type { StoreId, StoreInfo } from "./types"

export const STORE_CATALOG: StoreInfo[] = [
  { id: "target", name: "Target", skuHint: "TCIN or product URL", implemented: true },
  { id: "walmart", name: "Walmart", skuHint: "SKU or product URL", implemented: false },
  { id: "bestbuy", name: "Best Buy", skuHint: "SKU or product URL", implemented: false },
  { id: "pokemon-center", name: "Pokémon Center", skuHint: "Product URL", implemented: false },
  { id: "amazon", name: "Amazon", skuHint: "ASIN or product URL", implemented: false },
  { id: "crunchyroll", name: "Crunchyroll", skuHint: "Product URL", implemented: false }
]

export function storeName(id: StoreId): string {
  return STORE_CATALOG.find((store) => store.id === id)?.name ?? id
}

export function isStoreId(value: string): value is StoreId {
  return STORE_CATALOG.some((store) => store.id === value)
}
