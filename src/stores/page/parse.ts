import type { StoreId } from "../../shared/types"

export interface PageSpec {
  id: StoreId
  name: string
  skuHint: string
  home: string
  /** The only host this module may request. */
  host: string
  hosts: readonly string[]
  cautiousOutOfStock: boolean
  bare: RegExp
  pathId: RegExp
  canonical: (id: string) => string
}

export interface PageTarget {
  sku: string
  url: string
}

export type PageAvailability = "IN_STOCK" | "PRE_ORDER" | "UNAVAILABLE"

export interface PageReading {
  inStock: boolean
  status: PageAvailability
  title?: string
  sku: string
  price?: number
  reason: string
  seller: string
  imageUrl?: string
}

export const GAMESTOP: PageSpec = {
  id: "gamestop",
  name: "GameStop",
  skuHint: "Product URL or GameStop product id",
  home: "https://www.gamestop.com/",
  host: "www.gamestop.com",
  hosts: ["gamestop.com", "www.gamestop.com"],
  cautiousOutOfStock: false,
  bare: /^\d{5,9}$/,
  pathId: /\/(\d{5,9})\.html$/i,
  canonical: (id) => `https://www.gamestop.com/products/${id}.html`
}

export const BARNES_NOBLE: PageSpec = {
  id: "barnes-noble",
  name: "Barnes & Noble",
  skuHint: "Product URL or ISBN",
  home: "https://www.barnesandnoble.com/",
  host: "www.barnesandnoble.com",
  hosts: ["barnesandnoble.com", "www.barnesandnoble.com"],
  cautiousOutOfStock: false,
  bare: /^(?:\d{9}[\dXx]|\d{10,13})$/,
  pathId: /\/w\/(?:[^/]+\/)?(\d{9}[\dXx]|\d{10,13})\/?$/i,
  canonical: (id) => `https://www.barnesandnoble.com/w/${id}`
}

export const COSTCO: PageSpec = {
  id: "costco",
  name: "Costco",
  skuHint: "Product URL or Costco item number",
  home: "https://www.costco.com/",
  host: "www.costco.com",
  hosts: ["costco.com", "www.costco.com"],
  cautiousOutOfStock: true,
  bare: /^\d{5,12}$/,
  pathId: /\.product\.(\d{5,12})\.html$/i,
  canonical: (id) => `https://www.costco.com/.product.${id}.html`
}

export const SAMS: PageSpec = {
  id: "sams",
  name: "Sam's Club",
  skuHint: "Product URL or Sam's Club item number",
  home: "https://www.samsclub.com/",
  host: "www.samsclub.com",
  hosts: ["samsclub.com", "www.samsclub.com"],
  cautiousOutOfStock: false,
  bare: /^\d{5,14}$/,
  pathId: /\/ip\/(?:[^/]+\/)?(\d{5,14})\/?$/i,
  canonical: (id) => `https://www.samsclub.com/ip/${id}`
}

export const PAGE_SPECS: readonly PageSpec[] = [GAMESTOP, BARNES_NOBLE, COSTCO, SAMS]

export function pageSpec(id: StoreId): PageSpec | undefined {
  return PAGE_SPECS.find((spec) => spec.id === id)
}

export function parsePageTarget(spec: PageSpec, input: string): PageTarget | null {
  const text = input.trim()
  if (!text) return null
  if (spec.bare.test(text)) return { sku: normalizeId(text), url: spec.canonical(normalizeId(text)) }
  try {
    const url = new URL(text)
    if (url.protocol !== "https:") return null
    if (!spec.hosts.includes(url.hostname.toLowerCase())) return null
    const match = url.pathname.match(spec.pathId)
    const sku = match?.[1] ? normalizeId(match[1]) : ""
    if (!sku) return null
    return { sku, url: `https://${spec.host}${url.pathname}` }
  } catch {
    return null
  }
}

export function parsePageSku(spec: PageSpec, input: string): string | null {
  return parsePageTarget(spec, input)?.sku ?? null
}

/** A challenge page, not a product. The module pauses and a person finishes it. */
export function isPageChallenge(status: number, body: string): boolean {
  const sample = body.slice(0, 12000).toLowerCase()
  if (sample.includes("verifying your connection")) return true
  if (sample.includes("just a moment")) return true
  if (sample.includes("attention required")) return true
  if (sample.includes("px-captcha")) return true
  if (sample.includes("are-you-human")) return true
  if (sample.includes("verify you are human")) return true
  if (sample.includes("captcha") && !sample.includes("application/ld+json")) return true
  if ((status === 403 || status === 412) && !sample.includes('"@type"')) return true
  return false
}

export function isLoginWall(body: string): boolean {
  if (productRecord(body)) return false
  const sample = body.slice(0, 30000).toLowerCase()
  const passwordField = /<input[^>]+type=["']password["']/.test(sample)
  return passwordField && (sample.includes("sign in") || sample.includes("log in"))
}

/**
 * Product-page availability. InStock, LimitedAvailability, PreOrder, and PreSale
 * are purchasable. A visible Add to Cart control is too. Schema OutOfStock with
 * no add control is not treated as a live warehouse count.
 */
export function readPageOffer(spec: PageSpec, body: string, sku: string): PageReading {
  const product = productRecord(body)
  const offer = firstOffer(product?.offers)
  const availability = text(offer?.availability || product?.availability).toLowerCase()
  const title = text(product?.name)
  const price = money(offer?.price ?? offer?.lowPrice ?? product?.price)
  const add = hasAddControl(body)
  const preorder = /pre-?order|pre-?sale/.test(availability)
  const schemaBuy = /instock|limitedavailability|pre-?order|pre-?sale/.test(availability)
  const inStock = schemaBuy || add
  const status: PageAvailability = !inStock ? "UNAVAILABLE" : preorder && !/instock|limitedavailability/.test(availability) ? "PRE_ORDER" : "IN_STOCK"
  const name = title || sku
  const priced = price !== undefined ? ` at $${price.toFixed(2)}` : ""
  const reason = inStock
    ? `${name} is ${status === "PRE_ORDER" ? "open for preorder" : "in stock"}${priced}.`
    : spec.cautiousOutOfStock
      ? `${name} has no add-to-cart control on the Costco page. Warehouse inventory was not read.`
      : `${name} is not available on the product page.`
  return {
    inStock,
    status,
    title: title || undefined,
    sku,
    price,
    reason,
    seller: spec.name
  }
}

export function hasAddControl(html: string): boolean {
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  const tags = visible.match(/<(button|a)\b[^>]*>[\s\S]{0,180}?<\/\1>|<input\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    if (/\bdisabled\b/i.test(tag)) continue
    if (/add[\s-]*to[\s-]*(?:cart|bag)/i.test(tag)) return true
    if (/add-to-cart|addtocart|add_to_cart/i.test(tag)) return true
  }
  return false
}

function productRecord(body: string): Record<string, unknown> | null {
  const blocks = body.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  for (const block of blocks) {
    const found = findProduct(safeJson(block[1] ?? ""))
    if (found) return found
  }
  return null
}

function findProduct(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProduct(item)
      if (found) return found
    }
    return null
  }
  const record = asRecord(node)
  if (!record) return null
  if (isProductType(record["@type"])) return record
  if (record["@graph"]) return findProduct(record["@graph"])
  return null
}

function isProductType(value: unknown): boolean {
  const list = Array.isArray(value) ? value : [value]
  return list.some((item) => text(item).toLowerCase() === "product")
}

function firstOffer(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const offer = asRecord(item)
      if (offer) return offer
    }
    return null
  }
  return asRecord(value)
}

function money(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value * 100) / 100
  if (typeof value === "string") {
    const match = value.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/)
    if (match) return Math.round(Number(match[1]) * 100) / 100
  }
  return undefined
}

function normalizeId(value: string): string {
  return value.trim().replace(/x$/i, "X")
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}
