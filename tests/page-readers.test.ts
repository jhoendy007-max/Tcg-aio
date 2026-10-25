import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BARNES_NOBLE, COSTCO, GAMESTOP, SAMS, isPageChallenge, parsePageTarget, readPageOffer } from "../src/stores/page/parse"

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "pages", name), "utf8")

describe("Costco product page (real page data, 0.2.46)", () => {
  const page = fixture("costco-oos.html")

  it("reads title, price, image and the item key from the JSON-LD and og tags", () => {
    const reading = readPageOffer(COSTCO, page, "4000200441")
    expect(reading.title).toBe("MEGA Pokémon, Pokémon Discoveries")
    expect(reading.price).toBe(69.99)
    expect(reading.imageUrl).toMatch(/^https:\/\/gdx-assets\.costco\.com\//)
    expect(reading.inStock).toBe(false)
    expect(reading.source).toBe("json-ld")
    expect(reading.reason).toContain("Warehouse inventory was not read")
  })

  it("turns on when the page says InStock", () => {
    const live = page.replace("https://schema.org/OutOfStock", "https://schema.org/InStock")
    const reading = readPageOffer(COSTCO, live, "4000200441")
    expect(reading.inStock).toBe(true)
    expect(reading.status).toBe("IN_STOCK")
    expect(reading.fulfillment).toBe("ship")
    expect(reading.reason).toContain("$69.99")
  })

  it("accepts the item key from the new /p/ links and the older .product. links", () => {
    expect(parsePageTarget(COSTCO, "https://www.costco.com/p/-/mega-pokmon-pokmon-discoveries/4000200441")?.sku).toBe("4000200441")
    expect(parsePageTarget(COSTCO, "https://www.costco.com/pok%C3%A9mon-evolving-skies.product.100983804.html")?.sku).toBe("100983804")
  })
})

describe("Sam's Club product page (real page data, 0.2.46)", () => {
  const page = fixture("sams-oos.html")

  it("reads the Next.js product object: name, price, image, limit, and out of stock", () => {
    const reading = readPageOffer(SAMS, page, "17210852415")
    expect(reading.source).toBe("next-data")
    expect(reading.title).toBe("Pokémon Elite Trainer Box + Poke Ball")
    expect(reading.price).toBe(49.98)
    expect(reading.imageUrl).toMatch(/^https:\/\/i5\.samsclubimages\.com\//)
    expect(reading.limit).toBe(5)
    expect(reading.inStock).toBe(false)
    expect(reading.fulfillment).toBe("unknown")
  })

  it("is in stock only when shipping is available, and says so when only club pickup is", () => {
    const ship = page.replaceAll('"availabilityStatus": "NOT_AVAILABLE"', '"availabilityStatus": "IN_STOCK"').replace(/"availabilityStatus":"NOT_AVAILABLE"/g, '"availabilityStatus":"IN_STOCK"')
    const shipping = readPageOffer(SAMS, ship, "17210852415")
    expect(shipping.inStock).toBe(true)
    expect(shipping.fulfillment).toBe("ship")

    // Pickup available, shipping not.
    const pickupOnly = page.replace(/("type":\s*"PICKUP"[\s\S]*?"availabilityStatus":\s*)"NOT_AVAILABLE"/, '$1"IN_STOCK"')
    const reading = readPageOffer(SAMS, pickupOnly, "17210852415")
    expect(reading.inStock).toBe(false)
    expect(reading.fulfillment).toBe("pickup")
    expect(reading.reason).toMatch(/picked up in a club/i)
    expect(reading.reason).toMatch(/ship-to-home only/i)
  })

  it("an Add to cart button elsewhere on the page does not turn an out-of-stock item on (real-page regression)", () => {
    const withCarousel = page.replace("</body>", '<section class="recommended"><button type="button">Add to cart</button></section></body>')
    const reading = readPageOffer(SAMS, withCarousel, "17210852415")
    expect(reading.inStock).toBe(false)
  })

  it("recognises the Sam's Club robot check page so a person is asked", () => {
    const robot = "<html><head><title>Let us know you're not a robot - Sam's Club</title></head><body><h1>Let us know you’re human (no robots allowed)</h1></body></html>"
    expect(isPageChallenge(200, robot)).toBe(true)
    expect(isPageChallenge(200, page)).toBe(false)
  })

  it("never reads the member price as a reason to buy: it reports the price the signed-in member sees", () => {
    const withoutNext = page.replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/, "")
    const reading = readPageOffer(SAMS, withoutNext, "17210852415")
    expect(reading.source).toBe("json-ld")
    expect(reading.price).toBe(49.98)
    expect(reading.title).toBe("Pokémon Elite Trainer Box + Poke Ball")
  })

  it("accepts the product link and a bare item number", () => {
    expect(parsePageTarget(SAMS, "https://www.samsclub.com/ip/pokemon-elite-trainer-box-poke-ball/17210852415")?.sku).toBe("17210852415")
    expect(parsePageTarget(SAMS, "17210852415")?.url).toBe("https://www.samsclub.com/ip/17210852415")
  })
})

describe("Barnes & Noble product page (real page data, 0.2.46)", () => {
  const page = fixture("bn-oos.html")

  it("reads the ProductGroup variant: title, price, image, out of stock", () => {
    const reading = readPageOffer(BARNES_NOBLE, page, "1144045070")
    expect(reading.title).toBe("Gotta Catch All the Trading Cards")
    expect(reading.price).toBe(32.79)
    expect(reading.imageUrl).toMatch(/^https:\/\/cdn\.shopify\.com\//)
    expect(reading.inStock).toBe(false)
  })

  it("picks the edition from the link, skips eBooks, and prefers a buyable physical format", () => {
    const html = (variants: object[]) => `<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [{ "@type": "ProductGroup", name: "A Book", hasVariant: variants }]
    })}</script></head><body></body></html>`
    const offer = (price: string, availability: string) => ({ "@type": "Offer", price, availability: `https://schema.org/${availability}` })
    const variants = [
      { "@type": "Product", name: "A Book", sku: "9780000000001", bookFormat: "https://schema.org/EBook", offers: offer("9.99", "InStock") },
      { "@type": "Product", name: "A Book", sku: "9780000000002", bookFormat: "https://schema.org/Hardcover", offers: offer("29.99", "OutOfStock") },
      { "@type": "Product", name: "A Book", sku: "9780000000003", bookFormat: "https://schema.org/Paperback", offers: offer("14.99", "InStock") }
    ]
    const any = readPageOffer(BARNES_NOBLE, html(variants), "1144045070")
    expect(any.price).toBe(14.99)
    expect(any.inStock).toBe(true)
    expect(any.title).toBe("A Book (Paperback)")
    const hardcover = readPageOffer(BARNES_NOBLE, html(variants), "1144045070", "9780000000002")
    expect(hardcover.price).toBe(29.99)
    expect(hardcover.inStock).toBe(false)
    const target = parsePageTarget(BARNES_NOBLE, "https://www.barnesandnoble.com/w/a-book-author/1144045070?ean=9780000000002")
    expect(target).toMatchObject({ sku: "1144045070", variant: "9780000000002" })
  })

  it("turns a bare ISBN into the edition link, and keeps a work id as it is", () => {
    expect(parsePageTarget(BARNES_NOBLE, "9781098284268")).toMatchObject({ url: "https://www.barnesandnoble.com/w/?ean=9781098284268", variant: "9781098284268" })
    // ISBN-10 for the same book converts to the ISBN-13 the site accepts.
    expect(parsePageTarget(BARNES_NOBLE, "1098284267")?.url).toBe("https://www.barnesandnoble.com/w/?ean=9781098284268")
    // A 10-digit work id that is not a valid ISBN-10 stays a work id.
    expect(parsePageTarget(BARNES_NOBLE, "1144045070")?.url).toBe("https://www.barnesandnoble.com/w/1144045070")
  })
})

describe("GameStop product page (0.2.46)", () => {
  it("reads JSON-LD price and a per-account purchase limit, and treats Currently Unavailable as out of stock", () => {
    const html = (button: string) => `<html><head><meta property="og:image" content="https://media.gamestop.com/i/gamestop/20019415/x"><script type="application/ld+json">{"@type":"Product","name":"Journey Together Booster Bundle","offers":{"@type":"Offer","price":"59.99","availability":"https://schema.org/OutOfStock"}}</script></head><body><h2>Purchase Limit</h2><p>To ensure that everyone can join in the fun, only 1 unit of this item may be purchased per account.</p>${button}</body></html>`
    const out = readPageOffer(GAMESTOP, html("<p>Currently Unavailable</p>"), "20019415")
    expect(out.inStock).toBe(false)
    expect(out.price).toBe(59.99)
    expect(out.imageUrl).toContain("media.gamestop.com")
    expect(out.limit).toBe(1)
    const live = readPageOffer(GAMESTOP, html('<button class="add-to-cart" type="submit">Add to Cart</button>'), "20019415")
    expect(live.inStock).toBe(true)
    expect(live.limit).toBe(1)
  })

  it("accepts the real product link shape with an 8-digit id", () => {
    expect(parsePageTarget(GAMESTOP, "https://www.gamestop.com/toys-games/trading-cards/products/pokemon-trading-card-game-scarlet-and-violet-booster-bundle/20002524.html")?.sku).toBe("20002524")
  })
})
