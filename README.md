# TCGAIO

Windows desktop checkout assistant for Pokémon TCG and One Piece TCG drops. v0.1 monitors Target by TCIN, Walmart by item ID, Best Buy by SKU, Pokémon Center by SKU or product URL, and Crunchyroll Store by product ID or URL, adds the item to your own cart, and places a **ship-to-home** order with a saved profile. Amazon is a registered store module with checkout still stubbed.

Retailer terms often restrict automated purchasing. TCGAIO uses the account, proxies, and card you provide. It does not send challenges to a solving service. If Target, Walmart, Best Buy, Pokémon Center, or Crunchyroll shows a challenge or block, the task pauses and a Discord notification is sent so you can sign in yourself.

## What you get

- **Tasks** — store, SKU or URL, quantity, profile, account, proxy group, start/stop, and a live status log.
- **Profiles** — shipping and billing. Card number and CVV are encrypted locally.
- **Proxies** — import `host:port` or `host:port:user:pass` lists and test them.
- **Accounts** — per-store logins. Passwords and browser sessions are encrypted.
- **Settings** — Discord webhook and Target monitor delay, store ID, ZIP, and state.

On Windows, card numbers, CVVs, passwords, and sessions are encrypted with **Windows DPAPI** through Electron `safeStorage`. If DPAPI is unavailable (for example a Linux dev machine), the app falls back to AES-256-GCM with a key file in the app data folder. The Settings page shows which method is active. Secrets are not written to the task log or the Discord webhook. The card is sent only to `carts.target.com` during Target payment, only to `www.walmart.com` during Walmart payment, and only to `www.bestbuy.com` during Best Buy payment. Pokémon Center payment fetches a CyberSource Flex capture context with a GET that does not include the card, then posts the encrypted card only to `flex.cybersource.com`. Crunchyroll payment posts the card form only to `api.stripe.com` and sends the store a `pm_` id plus a masked card. Walmart's PIE key is fetched with a GET that does not include the card.

## Requirements

- Windows 10 or 11 to run the packaged app
- Node.js 22 to build from source
- A Target, Walmart, Best Buy, Pokémon Center, or Crunchyroll account you control, plus a browser session if password sign-in is challenged

## Setup

```powershell
git clone <this-repo>
cd tcg-aio
npm ci
```

## Develop

```powershell
npm run dev
```

That opens the Electron window with a reloading UI.

```powershell
npm test
npm run typecheck
npm run build
```

`npm run build` writes the unpacked app to `out/`. `npm run preview` launches that build.

## Build the Windows installer

On a Windows machine:

```powershell
npm ci
npm run dist:win
```

The NSIS installer is written to `release/TCGAIO-Setup-0.1.0.exe`. The installer is per-user and lets you choose the directory.

GitHub Actions also builds it. The workflow `.github/workflows/windows.yml` runs the tests, typecheck, and production build on Ubuntu, then runs `npm run dist:win` on `windows-latest` and uploads the `.exe` as the `TCGAIO-Windows-Setup` artifact.

App data lives in Electron's user data directory (`%APPDATA%\tcgaio` on Windows): `tcgaio.json` for tasks and ciphertext, and `tcgaio.key` only when the AES fallback is used.

## Usage

1. Open **Profiles** and save a US shipping address, billing address, and card. v0.1 ships inside the US only.
2. Open **Accounts**. Add a Target, Walmart, Best Buy, Pokémon Center, or Crunchyroll account.
   - Target password sign-in is attempted when no session is saved. Walmart, Best Buy, Pokémon Center, and Crunchyroll password sign-in are not attempted, because PerimeterX, Akamai, Incapsula, and Cloudflare block them.
   - The reliable path is a browser session. Sign in on the retailer site, open DevTools, and copy the cookies into the session box.
   - Target:

     ```text
     accessToken=...; visitorId=...; refreshToken=...
     ```

   - Walmart:

     ```text
     auth=...; CID=...
     ```

     JSON with the same field names works too. Extra cookies in the Walmart string are replayed with the request.
   - Best Buy: paste the cookie header from a signed-in `www.bestbuy.com` page, including `at` and `vt`.

     ```text
     at=...; vt=...; SID=...
     ```

   - Pokémon Center: paste the full cookie header from a signed-in `www.pokemoncenter.com` page. Two or more cookies are enough. A single `visitorId` cookie is not.
   - Crunchyroll: paste the cookie header from a signed-in `www.crunchyroll.com` store page, or paste the shopper access token (`eyJ...`) on its own. A guest token pauses before any request.
3. Optionally import a proxy group and run **Test**. A task starts on one proxy from the group. A Walmart task rotates to the next proxy in that group when PerimeterX returns HTTP 412, waits with backoff, and pauses if the block continues.
4. Open **Settings**. Set the Discord webhook (`https://discord.com/api/webhooks/...`), monitor delay, and the Target store ID / ZIP / state used for ship-to-home stock. Send the test webhook to confirm it.
5. Open **Tasks**. Create a task with a Target TCIN (`88897904`) or product URL (`https://www.target.com/p/.../-/A-88897904`), a Walmart item ID (`13816151308`) or product URL (`https://www.walmart.com/ip/.../13816151308`), a Best Buy SKU (`6606082`) or product URL (`https://www.bestbuy.com/product/.../sku/6606082`), a Pokémon Center SKU (`10-10416-112`) or product URL (`https://www.pokemoncenter.com/product/10-10416-112/...`), or a Crunchyroll product ID (`810158836396`) or product URL (`https://store.crunchyroll.com/products/...-810158836396.html`). Check the confirmation box. The checkbox is required before **Start** will run, because a successful monitor places a real order.
6. Press **Start**. The log shows monitoring, add to cart, shipping, payment, and the order id when the retailer accepts it. **Stop** aborts the run. **Resume** continues a paused task after you update the account session.

Stub stores can be selected. Starting one writes a clear failure: that module is registered, and checkout is not implemented in v0.1.

## Target flow

1. Load the saved session, or sign in with the saved password. A cart probe checks that the session is still accepted.
2. Poll `product_summary_with_fulfillment_v1` for the TCIN, and fall back to `pdp_fulfillment_v1` when the first payload has no shipping status. A blocked or challenge response pauses the task. HTTP 429 and 5xx retry on the monitor delay. Out of stock keeps monitoring. `IN_STOCK`, `LIMITED_STOCK`, and `PRE_ORDER_SELLABLE` for shipping continue.
3. `POST /web_checkouts/v1/cart_items` with your quantity, then set fulfillment to standard shipping.
4. `POST /web_checkouts/v1/cart_shipping_addresses` with the profile. Pickup is not requested.
5. `POST /checkout_payments/v1/payment_instructions` with the card and billing address.
6. `POST /web_checkouts/v1/checkout`. If Target asks for the CVV again, it is resubmitted once and checkout is retried.
7. On success, failure, or pause, the app posts to the Discord webhook when one is saved.

An expired session tries the refresh token, then the password. A challenge at any step pauses the task instead of looping.

## Walmart flow

1. Require a pasted browser session with the `auth` cookie (and `CID` when you have it). Password sign-in is not attempted.
2. Poll the persisted `GetAllSellerOffers` query for every seller of that item. A product-page `__NEXT_DATA__` read is the fallback when that call returns no product payload. HTTP 412, 418, and 456 rotate to the next proxy in the task's group, log which proxy was blocked, and wait `monitor delay × 2^(attempt-1)` up to 30 seconds. After `max(3, proxies × 2)` blocks in a row the task pauses. A "Robot or human?" page and press-and-hold pause immediately. The word PerimeterX on a normal product page does not. A normal response clears the block counter. HTTP 429 and 5xx retry on the monitor delay.
3. Continue only for an offer sold by Walmart.com itself (`sellerType` `INTERNAL`, `catalogSellerId` 0, or the seller name Walmart.com) with ship-to-home stock at or below the list or was price. Third-party sellers are ignored, including Fulfilled by Walmart. A marketplace listing, a Walmart.com price above that reference, pickup-only stock, and a missing item keep the monitor running.
4. `updateItems` adds the Walmart.com offer. Fulfillment is set to `SHIPPING`. Pickup is not requested.
5. `CreateDeliveryAddress` saves the profile address without making it the account default, then `setShipping` attaches it to the cart.
6. Fetch the current PIE key with GET `https://securedataweb.walmart.com/pie/v1/wmcom_us_vtg_pie/getkey.js`. That request carries no card data. The PAN and CVV are encrypted with PIE (embed=false) and `CreateAccountCreditCard` sends `encryptedPan`, `encryptedCVV`, `integrityCheck`, `keyId`, and `phase` only to `www.walmart.com`. The raw card number is not in that body.
7. `CreateBuyNowContract` opens one contract for that offer, then `placeOrder` submits it. If Walmart asks for the CVV again, the card is resubmitted once and place order is retried. Only `placeOrder` is the charge. After a success response, the cart line is set to quantity 0 so it is not bought again later.
8. On success, failure, or pause, the app posts to the Discord webhook when one is saved.

## Best Buy flow

1. Require a pasted signed-in browser session (the `www.bestbuy.com` cookie header, including `at`). Password sign-in is not attempted. A guest cart (`authStatus` `G`) pauses before monitoring.
2. A bare SKU is opened through `searchpage.jsp?st={sku}`, which follows the redirect to that SKU's product page. A product URL that already contains `/sku/{id}` is requested directly. The old `/site/{sku}.p` link is not used: live, it dropped SKU `6606082` and opened a marketplace sibling instead.
3. Read `productBySkuId` from the page. Continue only when the seller is Best Buy (`classification` `1P`, seller id `bby`, or the name Best Buy), ship-to-home is eligible, and the button is Add to Cart or Pre-order, at or below `regularPrice` when Best Buy sends one. Otherwise Best Buy's own current price counts. Marketplace sellers are ignored even when they can ship. `IN_STORE_ONLY` and a false `shippingEligible` stay on the monitor. HTTP 403 access-denied, Akamai, and captcha pages pause the task. "Please wait" on add to cart is a queue, not a captcha.
4. `POST /cart/api/v1/addToCart` with the SKU and quantity. `CONSTRAINED_ITEM` decodes the `a2ctransactioncode` wait (SHA-256, 0–899 seconds) and retries with the queue headers. `CONSTRAINED_ITEM_DHV` and `CONSTRAINED_ITEM_PERPETUAL` wait the numeric `a2ctransactionwait`. The task logs the wait and stops after 8 queue attempts.
5. `POST /cart/checkout`, then read `var orderData` from `/checkout/r/fast-track`. If `shippingEligible` is false, the task fails and does not place a pickup order. `PATCH /checkout/v3/{orderId}` sets shipping to the profile address without saving it as the account default.
6. Payment lookup stays on `www.bestbuy.com`. A 3-D Secure or Cardinal step-up pauses the task. TCGAIO does not call `centinelapi.cardinalcommerce.com` and does not generate Akamai sensor data.
7. GET `/api/csiservice/v2/key/tas` for the public key (no card in that request). The PAN is RSA-OAEP SHA-1 encrypted as `00960001` plus the digits. `PUT /payment/api/v3/payment/{id}/creditCard` sends that ciphertext and the CVV only to `www.bestbuy.com`. Payments are refreshed, then `POST /checkout/v3/{orderId}` places the order.
8. On success, failure, or pause, the app posts to the Discord webhook when one is saved.

## Pokémon Center flow

1. Require a pasted signed-in cookie header from `www.pokemoncenter.com`. Password sign-in is not attempted. A cart probe checks the session. HTTP 401 pauses for a fresh cookie header. A guest cart (`guest`, `isGuest`, `authenticated: false`, or `authStatus` `G`) pauses before monitoring.
2. A product URL is requested as given. A bare SKU is read from `GET /tpci-ecommweb-api/search` (`availability_status`, `pid`, `price`, `title`, `url`). If that payload does not include the SKU, the task requests `https://www.pokemoncenter.com/product/{sku}`. Stock is read from search docs or from `__NEXT_DATA__` (`addToCartForm` and `availability_status`). `IN_STOCK`, `AVAILABLE`, `LOW_STOCK`, and `PRE_ORDER` continue. `OUT_OF_STOCK`, `SOLD_OUT`, `UNAVAILABLE`, and `COMING_SOON` stay on the monitor. HTTP 429 and 5xx retry on the monitor delay.
3. DataDome (`var dd=`, `captcha-delivery.com`, "Please enable JS and disable any ad blocker"), Incapsula ("Pardon Our Interruption", "Request unsuccessful", `_Incapsula_Resource`), and an Imperva JSON block ("This request was blocked by our security service") pause the task. Discord is notified. TCGAIO does not solve captchas, DataDome cookies, or Imperva `reese84` challenges.
4. A Queue-it waiting room (a redirect to `*.queue-it.net`, or a page with `customerId` and `eventId`) is a line, not a captcha. The task POSTs `/spa-api/queue/{customerId}/{eventId}/enqueue` with an empty `challengeSessions` list, then polls `/status`. The log reads `Pokémon Center waiting room. Ahead of you: N. Checking again in Xs.` The site's `updateInterval` is used when it is between 1 and 120 seconds. The pass redirect is followed only when the host is `www.pokemoncenter.com`, and `QueueITAccepted` is kept on the session. `challengeRequired`, a captcha, or a proof-of-work request pauses the task. The queue host has to end in `.queue-it.net`, and card data is not sent there.
5. `POST /tpci-ecommweb-api/cart?type=product&format=nodatalinks` sends `productURI` from `addToCartForm`, the task quantity, and an empty `configuration`. An out-of-stock add to cart returns to the monitor.
6. `POST /tpci-ecommweb-api/cart/shipping-address?format=nodatalinks` sends the profile address with `isDefault: false`. Shipping methods are taken from that response or from `GET /tpci-ecommweb-api/cart/shipping-methods?format=nodatalinks`. The first method that is not pickup is posted to `/tpci-ecommweb-api/cart/shipping-method`. Pickup-only checkout fails and does not request a payment key. These address and order paths are the storefront BFF shape used by the fixture tests. A live checkout page was not available to confirm the field names.
7. `GET /tpci-ecommweb-api/get-payment-iframe-key?microform=true&locale=en-GB` returns a capture-context JWT and carries no card. The PAN, CVV, expiry, and card type (Visa `001`, Mastercard `002`, Amex `003`, Discover `004`) are encrypted as a CyberSource Flex compact JWE: RSA-OAEP with SHA-1 and A256GCM. The plaintext is `{ data: { CARD: { number, securityCode, type, expirationMonth, expirationYear } }, context, index: 0 }`. That JWE is posted only to the `flx.origin` + `flx.path` URL, and only when that host is `flex.cybersource.com` (normally `https://flex.cybersource.com/flex/v2/tokens`). The response JWT's `jti` is the payment token.
8. `POST /tpci-ecommweb-api/order?format=nodatalinks` sends `paymentKey` (the capture JWT), `paymentToken` (the `jti`), and the profile email. The raw card number and CVV are not in that body. A declined card fails without an order id.
9. On success, failure, or pause, the app posts to the Discord webhook when one is saved.

## Crunchyroll flow

1. Require a pasted signed-in session: the `www.crunchyroll.com` cookie header, or a shopper access token that starts with `eyJ`. Password sign-in is not attempted. A guest token (JWT `aut` of `GUEST`, or `isb` containing Guest) pauses before any request. No session means zero requests.
2. `store.crunchyroll.com` answers product URLs with HTTP 301 to `https://www.crunchyroll.com/store` and drops the product path, so the task calls the Salesforce Commerce Cloud Shopper API on `www.crunchyroll.com` and keeps the path. A bare 8–14 digit product id and a product URL that ends in that id are both accepted.
3. Poll `GET /mobify/proxy/api/product/shopper-products/v1/organizations/f_ecom_bdgc_prd/products/{id}?siteId=CrunchyrollUS&locale=en-US&currency=USD&expand=availability,prices`. A signed-in token is sent as `Authorization: Bearer`. Continue when `inventory.orderable`, `available`, preorder, or backorder is set and the availability message is not out of stock. The current price has to be at or under the list price when both are present. A higher current price stays on the monitor. HTTP 429 and 5xx retry. HTTP 404 stays on the monitor as not found.
4. Cloudflare (`cf-mitigated: challenge`, "Just a moment...", `challenges.cloudflare.com`, "Enable JavaScript and cookies to continue") pauses the task and Discord is notified. TCGAIO does not solve Cloudflare, Turnstile, or any other captcha. A JSON body that contains `orderable`, `productName`, or `tieredPrices` is treated as a product, not a challenge. HTTP 401 or `invalid access token` pauses for a fresh session.
5. `POST .../checkout/shopper-baskets/v1/organizations/f_ecom_bdgc_prd/baskets?siteId=CrunchyrollUS` creates a basket with the product id and the task quantity. `product-item-not-available` returns to the monitor. A 400 or 409 that already names a basket posts the item onto that basket.
6. `PUT .../baskets/{id}/customer` sets the profile email. `PUT .../shipments/me/shipping-address` sends the shipping address (`address1`, `stateCode`, `postalCode`, `countryCode` US), not the billing address. Methods come from that response or from `GET .../shipping-methods`. The first method that is not pickup (`c_storePickupEnabled`, or a pickup / BOPIS / in-store name) is `PUT` to `.../shipping-method`. Pickup-only checkout fails and does not call Stripe. These basket, address, and order paths follow the public Shopper API. A live checkout page was not available to confirm the field names.
7. The Stripe publishable key (`pk_live_` or `pk_test_`) is read from the product HTML. If it is missing, checkout fails and the card is not sent. `POST https://api.stripe.com/v1/payment_methods` sends `type=card`, `card[number]`, `card[exp_month]`, `card[exp_year]`, `card[cvc]`, and the billing address as form fields, with the publishable key as the bearer. That host is the only place the PAN and CVV go.
8. `POST .../baskets/{id}/payment-instruments` sends `paymentMethodId` `STRIPE`, `c_stripePaymentMethodId` (the `pm_` id), the card type, expiry, holder, and `maskedNumber` (`************` plus the last four). The raw card number and CVV are not in that body. `POST .../shopper-orders/v1/.../orders` places the order with `{ basketId }`. `requires_action`, `requires_source_action`, or `redirect_to_url` pauses for 3-D Secure. A declined card fails without an order id.
9. On success, failure, or pause, the app posts to the Discord webhook when one is saved.

## Adding a store

Each retailer is a `StoreModule` under `src/stores/<store>/`. The registry in `src/stores/registry.ts` is the only place that needs to know it exists. A module implements `run(ctx)` and returns `success`, `failed`, `paused`, or `stopped`. `ctx` provides the profile, account, the starting proxy, the proxy group, monitor settings, logger, and an HTTP client. The Amazon file is the stub to replace.

## What was tested, and what was not

Automated tests cover TCIN and proxy parsing, local encryption, masked profiles, the task runner, Discord payload redaction, Walmart, Best Buy, Pokémon Center, and Crunchyroll session cookies, Walmart PIE ciphertext against a fixed key, a Pokémon Center Flex JWE that decrypts back to the card, a Crunchyroll Stripe PaymentMethod body, Walmart 412 proxy rotation, and the Target, Walmart, Best Buy, Pokémon Center, and Crunchyroll sequences against a fake HTTP client: in-stock shipping checkout, a Best Buy please-wait queue, a Pokémon Center Queue-it wait that logs the line position, a wait through an out-of-stock or marketplace reading, a captcha pause before add-to-cart, a declined card, a CVV resubmit, and a 3-D Secure pause that does not call Cardinal. Pokémon Center challenge fixtures are trimmed from live DataDome and Incapsula responses. The Crunchyroll fixture is a trimmed Cloudflare "Just a moment..." page. The tests do not call the live sites.

A direct Target request from the development network, without a proxy, returned HTTP 435 and a PerimeterX captcha payload. Through a residential proxy, `product_summary_with_fulfillment_v1` returned real JSON: HTTP 200 for a physical store, and HTTP 206 with `Parameter store_id cannot be digital store 3991` when the store id is the old default. The legacy `pdp_fulfillment_v1` path returned HTTP 410. With store `1881` and ZIP `10001`, shipping status was `IN_STOCK` for TCIN `1012916220` (Destined Rivals Elite Trainer Box) and `OUT_OF_STOCK` for TCIN `1010892076` (30th Celebration Elite Trainer Box). New installs use store `1881`. Target checkout against a live cart was not run.

The same proxy's exit IP was `69.85.83.159` (ipify HTTP 200). Walmart product pages for Pokémon TCG items returned HTTP 200 with `__NEXT_DATA__`. The persisted `GetAllSellerOffers` query returned HTTP 200 when `allOffersSource` was omitted: item `13816151308` (Prismatic Evolutions Elite Trainer Box) had 41 offers, and the buy box was an external seller. Passing `SEARCH_TILE` hid those other sellers and returned only the buy box. A hand-written GraphQL query without the persisted hash returned HTTP 400. Search pages redirected to a "Robot or human?" block. A later offers call on the same proxy returned HTTP 412 with a PerimeterX `blockScript`. Every buy box sampled was a third-party seller, so the monitor correctly treats them as not in stock:

| Item | Page | Seller | Ship-to-home | Price |
| --- | --- | --- | --- | --- |
| 5521755697 Temporal Forces Iron Leaves ETB | HTTP 200 | Toywiz, external | Available | $187.88 |
| 17328862239 Mega Evolution ETB | HTTP 200 | Rares Market, external | Available | $148.98 |
| 13816151308 Prismatic Evolutions ETB | HTTP 200 | Unbeatable deals, external, Fulfilled by Walmart | Available | $134.66 |
| 1160437186 151 Booster Bundle | HTTP 200 | Rares Market, external | Available | $169.90 |
| 170986765 Shining Fates ETB | HTTP 200 | Unbeatable deals, external | Available | $183.99 |
| 5061672881 Charizard Ex Premium Box | HTTP 200 | T. Gaming, external | Available | $172.99 |
| 953848932 Shining Fates Pikachu V | HTTP 200 | Toywiz, external | Available | $113.88 |
| 4048737 | HTTP 404 | no product |  |  |

No Walmart.com listing was in those buy boxes. The 41-offer payload was counted, then the proxy was challenged with HTTP 412 before a second full seller list was saved, so it is unconfirmed whether any of those 41 sellers was Walmart.com. Add to cart, sign-in, checkout, and the live PIE key were not run against a Walmart payment call. PIE ciphertext is locked to the public embed=false algorithm with a fixed sample key. No purchase was made.

The same proxy was used for read-only Best Buy product pages (undici, HTTP/2 through the proxy). ipify was HTTP 200 and the exit IP was `69.85.83.159`. No add to cart, sign-in, or checkout was sent. No purchase was made.

| SKU | Request | HTTP | Seller | Ship-to-home | Price | Monitor |
| --- | --- | --- | --- | --- | --- | --- |
| 6606082 Prismatic Evolutions ETB | `/product/.../sku/6606082` | 200 | Best Buy, 1P | `shippingEligible` false, button `IN_STORE_ONLY` | $49.99 | Not in stock |
| 6606082 via `/site/6606082.p?skuId=6606082` | redirected to the BSIN page without `/sku/6606082` | 200 | Marketplace 12771570, 3P | Eligible | $159.99 | Ignored; the URL dropped the Best Buy SKU |
| 6606082 via `searchpage.jsp?st=6606082` | redirected to `/sku/6606082` | 200 | Best Buy, 1P | `IN_STORE_ONLY` | $49.99 | Not in stock |
| 12771570 Prismatic Evolutions ETB | `/site/12771570.p` | 200 | Marketplace, 3P | Add to Cart, eligible | $159.99 | Ignored |
| 12267167 Mega Evolution Ascended Heroes ETB | `/site/12267167.p` | 200 | Marketplace, 3P | Add to Cart, eligible | $198.99 | Ignored |
| 13114704 30th Celebration ETB | `/site/13114704.p` | 200 | Marketplace, 3P | Add to Cart, eligible | $191.39 | Ignored |
| 6668618 (redirected) Perfect Order ETB | ended on SKU 12799883 | 200 | Marketplace, 3P | Add to Cart, eligible | $94.99 | Ignored |

Sibling ids `6685559` and `6665449` redirected to the same marketplace ETB pages. None of these Pokémon listings were Best Buy ship-to-home at the time of the check. These pages included `customerPrice` and no separate regular price. Best Buy add to cart, the please-wait queue, sign-in, TAS encryption, and checkout were not run live.

The same proxy was used for read-only Pokémon Center requests (undici through the proxy, redirects not followed). ipify was HTTP 200 and the exit IP was `69.85.83.159`. No add to cart, sign-in, queue, payment, or checkout was sent. No purchase was made. None of the responses included product JSON, a price, or an availability status. The challenge parser matches these bodies.

| Request | HTTP | Body |
| --- | --- | --- |
| `www.pokemoncenter.com/` | 403 | DataDome HTML, 858 bytes. `var dd=`, "Please enable JS and disable any ad blocker", script `/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C`, host `geo.captcha-delivery.com` |
| Search `q=10-10416-112` (Mega Evolution Pitch Black ETB) | 403 | Same DataDome HTML, 858 bytes |
| Search `q=pokemon tcg elite trainer box` | 403 | DataDome script plus an Incapsula iframe, 855 bytes. "Request unsuccessful. Incapsula incident ID" |
| Search with `Accept: application/json` for `10-10416-112` and for `pokemon tcg` | 403 | Imperva JSON, `errorCode` `15`, "This request was blocked by our security service" |
| `GET /tpci-ecommweb-api/cart?format=nodatalinks` | 403 | DataDome JSON whose `url` is `https://geo.captcha-delivery.com/interstitial/` |
| `/product/10-10416-112/...` Mega Evolution Pitch Black ETB | 403 | DataDome HTML |
| `/product/290-85466/...` Scarlet & Violet 151 ETB | 200 | Incapsula "Pardon Our Interruption", 6183 bytes, `_Incapsula_Resource` |
| `/product/178-80980/...` Evolving Skies Pokémon Center ETB | 200 | Same Incapsula interstitial |
| `/product/153-80123/...` Fates Collide ETB | 200 | Same Incapsula interstitial |
| `/category/trading-card-game` | 200 | Same Incapsula interstitial |

Pokémon Center add to cart, the Queue-it waiting room, sign-in, CyberSource Flex tokenization, and checkout were not run live. The shipping-address, shipping-method, and order requests are covered by the fake HTTP client only.

The same proxy was used for read-only Crunchyroll Store requests (undici through the proxy, redirects not followed). ipify was HTTP 200 and the exit IP was `69.85.83.159`. No add to cart, sign-in, Stripe call, or checkout was sent. No purchase was made. No response included product JSON, a price, or an availability flag. The challenge parser matches the Cloudflare bodies (`cf-mitigated: challenge`, title "Just a moment...").

| Product | store.crunchyroll.com | www product page | Shopper Products API |
| --- | --- | --- | --- |
| 810158836396 Azure Sea's Seven booster box | 301 to `https://www.crunchyroll.com/store` | 403 Cloudflare challenge | 403 Cloudflare challenge |
| 810059787315 Four Emperors booster box | 301, same location | 403 Cloudflare challenge | 403 Cloudflare challenge |
| 810158838444 Kami's Island booster box | 301, same location | 403 Cloudflare challenge | 403 Cloudflare challenge |
| 810158833524 Carrying on His Will booster box | 301, same location | 403 Cloudflare challenge | 403 Cloudflare challenge |
| 810158833463 The Best Vol. 2 booster box | 301, same location | 403 Cloudflare challenge | 403 Cloudflare challenge |

`https://store.crunchyroll.com/` was the same HTTP 301. `https://www.crunchyroll.com/store` was HTTP 403 with the same challenge. The 301 body is 167 bytes and titled "301 Moved Permanently". The www pages are about 5.8 KB and the shopper-products responses are about 6.5 KB. None of them contain `orderable` or a price.

Crunchyroll add to cart, sign-in, the Stripe publishable key, payment-method creation, shipping-address and shipping-method field names, and place order were not run live. Those steps are covered by the fake HTTP client only.

Target, Walmart, Best Buy, Pokémon Center, and Crunchyroll change response shapes, and sign-in or cart calls can be blocked. Expect a paused task until you paste a fresh browser session. Confirm a small in-stock item you actually want before pointing a task at a drop.
