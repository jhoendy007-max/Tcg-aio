import type { HttpResponse } from "../../engine/http"
import { finishTest, isFinalSubmit, note } from "../../engine/test-mode"
import { checkoutPreflight, paceAddToCart } from "../module"
import type { StoreRunContext, StoreRunResult } from "../module"
import { checkoutCopy, checkoutLang } from "./copy"
import {
  checkoutBody,
  encodeFields,
  headerValue,
  parseStoreForms,
  readOrderId,
  sameStoreUrl,
  savedCard,
  type StoreForm
} from "./forms"
import { isLoginWall, isPageChallenge } from "./parse"

export interface CheckoutSite {
  id: StoreRunContext["task"]["store"]
  name: string
  host: string
  /** What the owner does when the store's page needs a person for a step. Shown in the log and the Dry run report. */
  ownerStep?: string
}

export interface CheckoutFetch {
  request(method: "GET" | "POST", url: string, referer: string, body?: string): Promise<{ kind: "ok"; value: HttpResponse } | { kind: "paused" | "failed"; reason: string }>
}

export type CheckoutDone = StoreRunResult | { outcome: "oos"; reason: string }

/**
 * Walks the forms already on the store page. A missing cart form pauses.
 * The card number is posted only to a tokenization form on this host.
 * Test mode returns before the place-order form is submitted.
 */
export async function checkoutFromPage(
  ctx: StoreRunContext,
  site: CheckoutSite,
  pageUrl: string,
  html: string,
  title: string,
  sku: string,
  price: number | undefined,
  fetch: CheckoutFetch,
  options: { limit?: number } = {}
): Promise<CheckoutDone> {
  const copy = checkoutCopy(checkoutLang(ctx.settings.language))
  const preflight = checkoutPreflight(ctx, price)
  if (preflight) {
    note(ctx, "cart", "skip", preflight.reason)
    return preflight
  }

  const quantity = options.limit && options.limit > 0 ? Math.min(ctx.task.quantity, options.limit) : ctx.task.quantity
  if (quantity < ctx.task.quantity) ctx.log("warn", `${site.name} limits this item to ${quantity} per account. Zzz AIO asks for ${quantity}, not ${ctx.task.quantity}.`)

  // Every page the checkout walked through, newest last. A cart remove control can be on any of them.
  const pages: { url: string; html: string }[] = [{ url: pageUrl, html }]
  const done = () => finishDry(ctx, site, fetch, pages, seen, copy)

  let currentUrl = pageUrl
  let currentHtml = html
  let cartDone = false
  let addressNoted = false
  let shippingNoted = false
  let tokenDone = false
  let paymentDone = false
  const seen = new Set<string>()

  for (let step = 0; step < 8; step += 1) {
    if (ctx.signal.aborted) return { outcome: "stopped", reason: "Stopped" }
    if (isPageChallenge(200, currentHtml)) return { outcome: "paused", reason: copy.challenge(site.name) }
    if (isLoginWall(currentHtml)) return { outcome: "paused", reason: copy.notSignedIn(site.name) }
    const forms = parseStoreForms(currentHtml, currentUrl, site.host, site.id)

    if (!cartDone) {
      const cart = forms.find((form) => form.kind === "cart")
      if (!cart) {
        note(ctx, "cart", "skip", `Zzz AIO did not add it to the cart.${site.ownerStep ? ` ${site.ownerStep}` : ""}`)
        if (site.ownerStep) ctx.log("warn", site.ownerStep)
        note(ctx, "address", "skip", copy.addressSkip)
        note(ctx, "shipping", "skip", copy.shippingSkip)
        note(ctx, "payment", "skip", "The card number was not sent.")
        return { outcome: "paused", reason: copy.handoff(title || sku) }
      }
      const posted = await postStep(ctx, site, fetch, cart, "cart", sku, false, currentUrl, seen, copy, quantity)
      if (posted.kind === "oos") return { outcome: "oos", reason: posted.reason }
      if (posted.kind !== "ok") {
        note(ctx, "cart", "fail", posted.reason)
        return posted.kind === "tested" ? await done() : asStop(posted)
      }
      note(ctx, "cart", "pass", copy.cartPass)
      cartDone = true
      currentUrl = posted.url
      currentHtml = posted.html
      pages.push({ url: posted.url, html: posted.html })
      continue
    }

    ctx.phase("checking_out")
    const address = forms.find((form) => form.kind === "address")
    if (address) {
      const posted = await postStep(ctx, site, fetch, address, "address", sku, false, currentUrl, seen, copy, quantity)
      if (posted.kind !== "ok") {
        note(ctx, "address", "fail", posted.reason)
        return posted.kind === "tested" ? await done() : asStop(posted)
      }
      note(ctx, "address", "pass", copy.addressPass)
      addressNoted = true
      if (posted.shipping) {
        note(ctx, "shipping", "pass", copy.shippingPass)
        shippingNoted = true
      }
      currentUrl = posted.url
      currentHtml = posted.html
      pages.push({ url: posted.url, html: posted.html })
      continue
    }
    if (!addressNoted) {
      note(ctx, "address", "skip", copy.addressSkip)
      addressNoted = true
    }

    const shipping = forms.find((form) => form.kind === "shipping")
    if (shipping) {
      const posted = await postStep(ctx, site, fetch, shipping, "shipping", sku, false, currentUrl, seen, copy, quantity)
      if (posted.kind !== "ok") {
        note(ctx, "shipping", "fail", posted.reason)
        return posted.kind === "tested" ? await done() : asStop(posted)
      }
      note(ctx, "shipping", "pass", copy.shippingPass)
      shippingNoted = true
      currentUrl = posted.url
      currentHtml = posted.html
      pages.push({ url: posted.url, html: posted.html })
      continue
    }
    if (!shippingNoted) {
      note(ctx, "shipping", "skip", copy.shippingSkip)
      shippingNoted = true
    }

    if (!paymentDone) {
      const token = forms.find((form) => form.kind === "token")
      const payment = forms.find((form) => form.kind === "payment")
      const place = forms.find((form) => form.kind === "place")
      if (token && !tokenDone) {
        const posted = await postStep(ctx, site, fetch, token, "token", sku, true, currentUrl, seen, copy, quantity)
        if (posted.kind !== "ok") {
          note(ctx, "payment", "fail", posted.reason)
          return posted.kind === "tested" ? await done() : asStop(posted)
        }
        note(ctx, "payment", "pass", copy.tokenPass)
        tokenDone = true
        currentUrl = posted.url
        currentHtml = posted.html
        pages.push({ url: posted.url, html: posted.html })
        continue
      }
      if (payment) {
        const posted = await postStep(ctx, site, fetch, payment, "payment", sku, !tokenDone, currentUrl, seen, copy, quantity)
        if (posted.kind !== "ok") {
          note(ctx, "payment", "fail", posted.reason)
          return posted.kind === "tested" ? await done() : asStop(posted)
        }
        note(ctx, "payment", "pass", savedCard(payment, ctx.profile.last4) ? copy.savedCard : copy.tokenPass)
        paymentDone = true
        currentUrl = posted.url
        currentHtml = posted.html
        pages.push({ url: posted.url, html: posted.html })
        continue
      }
      if (place && savedCard(place, ctx.profile.last4)) {
        note(ctx, "payment", "pass", copy.savedCard)
        paymentDone = true
      } else if (tokenDone) {
        note(ctx, "payment", "pass", copy.tokenPass)
        paymentDone = true
      } else {
        note(ctx, "payment", "skip", "The card number was not sent.")
        return { outcome: "paused", reason: copy.noPayment(site.name) }
      }
    }

    const place = forms.find((form) => form.kind === "place")
    if (!place) return { outcome: "paused", reason: copy.noPlace(site.name) }
    if (ctx.testMode) return done()
    const posted = await postStep(ctx, site, fetch, place, "place", sku, false, currentUrl, seen, copy, quantity)
    if (posted.kind !== "ok") return posted.kind === "tested" ? await done() : asStop(posted)
    const orderId = readOrderId(posted.html)
    return { outcome: "success", orderId: orderId || undefined, detail: copy.accepted(site.name, orderId) }
  }
  return { outcome: "failed", reason: copy.repeated }
}

/**
 * End of a Dry run. When the setting is on, the test item comes out of the cart through the store's own
 * remove form, if one was on a page this checkout saw. Otherwise the report says to remove it by hand.
 */
async function finishDry(
  ctx: StoreRunContext,
  site: CheckoutSite,
  fetch: CheckoutFetch,
  pages: { url: string; html: string }[],
  seen: Set<string>,
  copy: ReturnType<typeof checkoutCopy>
): Promise<StoreRunResult> {
  if (ctx.clearCartAfterTest && !ctx.cartRemoved) {
    let found: { form: StoreForm; url: string } | undefined
    for (const page of [...pages].reverse()) {
      const form = parseStoreForms(page.html, page.url, site.host, site.id).find((item) => item.kind === "remove")
      if (form) {
        found = { form, url: page.url }
        break
      }
    }
    if (!found) {
      note(ctx, "cart", "skip", `${site.name} did not show a remove control on the pages Zzz AIO saw, so the test item was left in the cart. Remove it by hand.`)
    } else {
      const posted = await postStep(ctx, site, fetch, found.form, "remove", "", false, found.url, seen, copy, 1)
      ctx.cartRemoved = posted.kind === "ok"
      note(ctx, "cart", posted.kind === "ok" ? "pass" : "fail", posted.kind === "ok" ? "Removed the test item from the cart." : `The test item could not be removed from the ${site.name} cart (${posted.reason}). Remove it by hand.`)
    }
  }
  return finishTest(ctx)
}

async function postStep(
  ctx: StoreRunContext,
  site: CheckoutSite,
  fetch: CheckoutFetch,
  form: StoreForm,
  mode: StoreForm["kind"],
  sku: string,
  requireSaved: boolean,
  referer: string,
  seen: Set<string>,
  copy: ReturnType<typeof checkoutCopy>,
  quantity: number
): Promise<{ kind: "ok"; html: string; url: string; shipping: boolean } | { kind: "paused" | "failed" | "oos" | "tested"; reason: string }> {
  const key = `${mode} ${form.action}`
  if (seen.has(key)) return { kind: "failed", reason: copy.repeated }
  seen.add(key)
  if (mode === "place" && ctx.testMode) return { kind: "tested", reason: "Test mode stopped before the place-order request." }
  if (form.method === "POST" && isFinalSubmit(site.id, { method: "POST", url: form.action }) && ctx.testMode) {
    return { kind: "tested", reason: "Test mode stopped before the place-order request." }
  }
  const planned = checkoutBody({ form, mode, sku, quantity, profile: ctx.profile, requireSaved })
  if (!planned.ok) {
    if (planned.reason === "pickup") return { kind: "failed", reason: copy.pickup }
    return { kind: "paused", reason: copy.noPayment(site.name) }
  }
  if (mode === "cart") {
    await paceAddToCart(ctx)
    ctx.phase("adding_to_cart")
  }
  const response = await send(ctx, site, fetch, form, planned.fields, referer, copy)
  if (response.kind !== "ok") return response
  if (mode === "cart" && soldOut(response.html)) return { kind: "oos", reason: copy.soldOut }
  if (declined(response.html)) return { kind: "failed", reason: copy.stepFailed(response.status) }
  return { kind: "ok", html: response.html, url: response.url, shipping: planned.shipping }
}

async function send(
  ctx: StoreRunContext,
  site: CheckoutSite,
  fetch: CheckoutFetch,
  form: StoreForm,
  fields: Record<string, string>,
  referer: string,
  copy: ReturnType<typeof checkoutCopy>
): Promise<{ kind: "ok"; html: string; url: string; status: number } | { kind: "paused" | "failed"; reason: string }> {
  const body = form.method === "POST" ? encodeFields(fields) : undefined
  let url = form.action
  if (form.method === "GET") {
    const next = new URL(form.action)
    for (const [key, value] of Object.entries(fields)) next.searchParams.set(key, value)
    url = next.toString()
  }
  const response = await fetch.request(form.method, url, referer, body)
  if (response.kind !== "ok") return response
  return settle(ctx, site, fetch, response.value, url, copy)
}

async function settle(
  ctx: StoreRunContext,
  site: CheckoutSite,
  fetch: CheckoutFetch,
  response: HttpResponse,
  action: string,
  copy: ReturnType<typeof checkoutCopy>,
  hops = 0
): Promise<{ kind: "ok"; html: string; url: string; status: number } | { kind: "paused" | "failed"; reason: string }> {
  if (isPageChallenge(response.status, response.body)) return { kind: "paused", reason: copy.challenge(site.name) }
  if (response.status === 401 || isLoginWall(response.body)) return { kind: "paused", reason: copy.notSignedIn(site.name) }
  if (response.status >= 300 && response.status < 400) {
    const location = sameStoreUrl(action, headerValue(response.headers, "location"), site.host)
    if (!location) return { kind: "failed", reason: copy.offHost }
    if (hops >= 1) return { kind: "failed", reason: copy.repeated }
    const next = await fetch.request("GET", location, action)
    if (next.kind !== "ok") return next
    return settle(ctx, site, fetch, next.value, location, copy, hops + 1)
  }
  if (response.status < 200 || response.status >= 400) return { kind: "failed", reason: copy.stepFailed(response.status) }
  return { kind: "ok", html: response.body, url: action, status: response.status }
}

function soldOut(body: string): boolean {
  const forms = body.slice(0, 5000).toLowerCase()
  if (forms.includes("<form")) return false
  return forms.includes("out of stock") || forms.includes("sold out")
}

function declined(body: string): boolean {
  const sample = body.slice(0, 4000).toLowerCase()
  return sample.includes("card was declined") || sample.includes("payment declined") || sample.includes("could not place") || sample.includes("unable to process your order")
}

function asStop(step: { kind: "paused" | "failed" | "oos" | "tested"; reason: string }): StoreRunResult {
  if (step.kind === "paused") return { outcome: "paused", reason: step.reason }
  if (step.kind === "tested") return { outcome: "tested", detail: step.reason }
  return { outcome: "failed", reason: step.reason }
}
