import type { StoreId } from "../../../shared/types"

const TONE: Record<StoreId, string> = {
  target: "#c83e3e",
  walmart: "#3d7ec8",
  bestbuy: "#d6a437",
  "pokemon-center": "#d4533c",
  amazon: "#e08a2c",
  crunchyroll: "#e07a2f",
  bandai: "#3d6cb5"
}

const LETTER: Record<StoreId, string> = {
  target: "T",
  walmart: "W",
  bestbuy: "B",
  "pokemon-center": "P",
  amazon: "A",
  crunchyroll: "C",
  bandai: "N"
}

export function StoreMark({ store, name, size = 28 }: { store: StoreId; name: string; size?: number }) {
  return (
    <svg className="store-mark" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={name}>
      <rect width="32" height="32" rx="8" fill={TONE[store]} />
      <text x="16" y="21" textAnchor="middle" fill="#fff" fontSize="14" fontFamily="Segoe UI, sans-serif" fontWeight="700">{LETTER[store]}</text>
    </svg>
  )
}

export function ProductVisual({ store, name, sku, imageUrl, size = 40 }: { store: StoreId; name: string; sku: string; imageUrl?: string; size?: number }) {
  if (imageUrl) return <img className="product-photo" src={imageUrl} alt="" width={size} height={size} />
  return <StoreMark store={store} name={`${name}, ${sku}`} size={size} />
}
