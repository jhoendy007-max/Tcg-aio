# TCGAIO

Windows desktop checkout assistant for Pokémon TCG and One Piece TCG drops. v0.2 monitors Target by TCIN, Walmart by item ID, Best Buy by SKU, Pokémon Center by SKU or product URL, Crunchyroll Store by product ID or URL, Amazon by ASIN or product URL, and Premium Bandai by product code. GameStop, Barnes & Noble, Costco, and Sam's Club watch the product page with your saved session and stop so you can add the item in that browser. TCGplayer Direct watches the public catalog. Pokémon Center and Premium Bandai remain the official US preorder sources. A companion iOS and Android app can watch and control tasks. The PC keeps running the checkout.

Retailer terms often restrict automated purchasing. TCGAIO uses the account, proxies, and card you provide. It does not send challenges to a solving service. If a store shows a challenge or block, the task pauses and a Discord notification is sent so you can sign in yourself.

Test mode, from Settings or a task, runs the real monitor, cart, address, shipping, and payment-token steps and stops before place order. The place-order request is refused by the task HTTP client, so it cannot be sent. A TEST badge shows on the desktop and the phone. Run test starts that path for one task. Store health check sends one read-only GET per store through the selected proxy group. `npm run bench:monitors -- --n 5` repeats those checks and prints p50, p95, and the success rate. Add `--proxy host:port` to send them through one proxy.

## What you get

- **Home** — active tasks, today's checkouts, spend, success rate, and proxy and session health.
- **Tasks** — separate monitor and checkout tasks. A monitor watches a SKU, URL, or keywords and can start several linked checkouts. A checkout can start by hand, on a schedule, from a monitor, from a restock alert, or with its own monitor. Delays, caps, hours, and the webhook can change while a task is running. The same editor is on the phone, in English or Spanish. Compact or detailed. Dark, light, and accent colors, plus a name and logo, are in Settings.
- **Setup** — a first-run wizard for a profile, an account, optional proxies, and one test-mode task. It stays hidden once you have a profile or an account, or after you skip it.
- **Profiles** — shipping and billing. Card number and CVV are encrypted locally.
- **Proxies** — import `host:port` or `host:port:user:pass` lists and test them.
- **Accounts** — per-store logins. Passwords and browser sessions are encrypted.
- **Stores** — one settings page per store, with recommended defaults, reset, and JSON presets. A task override wins over the store, which wins over global Settings. The same page is on the phone, in English or Spanish.
- **Settings** — Discord webhook, Target monitor delay, store ID, ZIP, and state, and read-only IMAP mailboxes. An email address fills the server settings. Google and Microsoft can sign in; iCloud and Yahoo use an app password. The same mail screen is on the phone, in English or Spanish.
- **Phone** — pair an iOS or Android app with a one-time QR code, then start, stop, edit, and watch tasks from the phone. Card numbers and passwords stay on the PC.
- **Session Sync** — a Chrome or Edge extension that sends your own store sign-in to this PC. You link each account. It does not read other sites.

On Windows, card numbers, CVVs, passwords, and sessions are encrypted with **Windows DPAPI** through Electron `safeStorage`. If DPAPI is unavailable (for example a Linux dev machine), the app falls back to AES-256-GCM with a key file in the app data folder. The Settings page shows which method is active. Secrets are not written to the task log or the Discord webhook. The card is sent only to `carts.target.com` during Target payment, only to `www.walmart.com` during Walmart payment, and only to `www.bestbuy.com` during Best Buy payment. Pokémon Center payment fetches a CyberSource Flex capture context with a GET that does not include the card, then posts the encrypted card only to `flex.cybersource.com`. Crunchyroll payment posts the card form only to `api.stripe.com` and sends the store a `pm_` id plus a masked card. Amazon checkout uses the address and payment already saved on the Amazon account and does not send the card number or CVV. Walmart's PIE key is fetched with a GET that does not include the card.

## Requirements

- Windows 10 or 11 to run the packaged desktop app
- Node.js 22 to build from source
- Android 8 or newer for the phone APK. iOS needs an Apple Developer account (see below)
- A Target, Walmart, Best Buy, Pokémon Center, Crunchyroll, or Amazon account you control, plus a browser session if password sign-in is challenged

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

The NSIS installer is written to `release/TCGAIO-Setup-0.2.0.exe`. The installer is per-user and lets you choose the directory. `dist:win` passes `--publish never`, so a branch build does not need a GitHub token. A `v*` tag publishes the installer as a GitHub Release.

GitHub Actions (`.github/workflows/windows.yml`) runs the tests, typecheck, and production build on Ubuntu, then `npm run dist:win` on `windows-latest` and uploads the `.exe`. The same workflow builds the Android APK and packs the Session Sync zip.

## Session Sync

Session Sync is a Chrome and Edge extension. It copies a store sign-in you already have in that browser into the encrypted vault on your PC. It reads cookies only for an account you link, and only on the stores in the catalog (Target, Walmart, Best Buy, Pokémon Center, Amazon, Crunchyroll, Premium Bandai, GameStop, Barnes & Noble, Costco, Sam's Club, and TCGplayer). It does not collect other sites, share a session with anyone else, or create cookies.

A tagged release includes `TCGAIO-Session-Sync-0.2.14.zip` next to the Windows installer and the phone APK.

The Android home screen can show a TCGAIO widget with wins and active tasks. iOS widgets are not in this beta. The phone still follows the desktop theme, and each task can be swiped or tapped.

1. Download that zip and unzip it. `manifest.json` has to be in the folder you select, not inside a second folder.
2. Open `chrome://extensions` or `edge://extensions`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the unzipped folder.
5. On the desktop **Phone** page, create a pairing code. It expires in three minutes and works once. The same code pairs a phone or this extension.
6. Open the extension, paste the code, and pair. The PC lists it as **Session Sync**. Revoke it from that device list when you want it to stop.
7. Link each account, then use **Sync now** or sign in on that store. Cookie changes for a linked account sync on their own.
8. Two-way is optional. When it is on, a session the app refreshes can be written back into this browser. Those are cookies the PC already saved.

To pack a `.crx` on your own machine, use **Pack extension** on the extensions page and keep the `.pem` it gives you. Do not commit that key. Chrome only installs a packed `.crx` from the Chrome Web Store or an enterprise policy, so **Load unpacked** is the install path for a personal browser. From a checkout you can also run `npm run pack:extension`. That writes the zip and a `.crx` under `release/` and does not save the private key.

The desktop **Session Sync** page shows which browser is linked, when the session expires, when it was last used, and whether it is expiring or logged out. A check once a minute flags a saved session that has expired. It does not open the store login page. Expiring and logged-out notices go to Discord and a paired phone at most once a day. The cookie stays in the encrypted vault.

App data lives in Electron's user data directory (`%APPDATA%\tcgaio` on Windows): `tcgaio.json` for tasks and ciphertext, and `tcgaio.key` only when the AES fallback is used.

## Phone app

The desktop app is the engine. Leave it running. The phone does not check out by itself, and it never receives the card number, CVV, account password, store session, or proxy password. Profiles show the name, card last four, city, and state. Accounts show a masked username. Proxy groups show a name and a count. Session Sync is the only client that receives a saved store cookie, and only for an account that browser linked with two-way sync.

### How the connection works

Pairing is a one-time QR code on the desktop **Phone** page. The code contains the PC's LAN address, an optional relay URL, and a 32-byte secret that expires in three minutes and works once. Every later frame is AES-256-GCM. The pairing secret wraps the first exchange, which issues a device token stored on the phone (Expo SecureStore) and encrypted on the PC with the same cipher as the card data. The token is not written in the clear. Revoke a phone from the desktop list and its token stops working.

Two paths:

| Path | When it works | Tradeoff |
| --- | --- | --- |
| Direct WebSocket on the LAN (`ws://<pc>:47321`) | Phone and PC on the same Wi-Fi. Windows may ask to allow TCGAIO on private networks. | Fast, and no third party sees the frames. It does not work away from home, and an unencrypted socket is fine only because the frames themselves are AES-GCM with a key that came from the QR. |
| Optional relay | Phone is away from home. On the PC, save a `ws://` or `wss://` relay URL, then pair again so the QR includes it. | The phone and PC both dial out, so home NAT does not have to accept an inbound port. The relay only routes ciphertext. Whoever runs the relay can drop traffic and can see that a PC id is connected, but cannot read tasks. You run the relay yourself: `npm run phone:relay` (port 47322, or `PHONE_RELAY_PORT`). Put it on a VPS and prefer `wss://` in front of it (Caddy or nginx). There is no TCGAIO-hosted relay. |

The phone tries the LAN address first, then the relay. "PC online" means the socket is up. If the app is suspended, iOS will drop the socket; Android can keep it while the app is in the foreground. Checkout success, failure, and paused/challenge notices are local notifications delivered while the socket is connected. Remote push after the app is killed needs Apple Push Notification service or Firebase, which requires your developer accounts and is not wired in this beta.

### Android

The installable debug APK is `TCGAIO-Phone-0.2.0.apk` (arm64-v8a, which covers current phones). Enable install from unknown sources, install it, and pair. A debug APK is signed with the Android debug key, so a later build from another machine will not update over it until you uninstall.

To build it:

```powershell
cd mobile
npm ci
npx expo prebuild --platform android
cd android
.\gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a
```

### iOS, which you have to do

This repo cannot produce an installable iPhone build. Apple only signs iOS apps for an Apple Developer Program account ($99/year).

1. Enroll at https://developer.apple.com/programs/.
2. From `mobile/`, run `npx eas login` and `npx eas init` so `app.json` gets your EAS project id (it ships with a placeholder).
3. TestFlight: `npx eas build -p ios --profile production`, then `npx eas submit -p ios --profile production`. Install from the TestFlight email after Apple finishes processing.
4. Or, on a Mac with Xcode: `npx expo prebuild --platform ios`, open the generated `mobile/ios` workspace, select your team, and run on a device.

`eas.json` also has a `preview` profile (`distribution: internal`) for a device-registered ad hoc build. The bundle id is `com.tcgaio.phone`.

### What pairing tests cover

`npm test` pairs a phone client to the desktop listener on localhost, checks that a second use of the same QR fails, that an expired QR fails, and that revoke closes the phone. A second test pairs only through the relay and checks the relay log does not contain the task SKU, the card number, the account password, or the pairing secret. The masked profile, account, and proxy projections are asserted directly. The camera scan is the same payload as the paste box; the socket tests use that payload.

## Usage

1. Open **Profiles** and save a US shipping address, billing address, and card. Shipping is US only.
2. Open **Accounts**. Add a Target, Walmart, Best Buy, Pokémon Center, Crunchyroll, or Amazon account.
   - Target password sign-in is attempted when no session is saved. Walmart, Best Buy, Pokémon Center, Crunchyroll, and Amazon password sign-in are not attempted, because PerimeterX, Akamai, Incapsula, Cloudflare, and Amazon's robot check block them.
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
   - Amazon: paste the cookie header from a signed-in `www.amazon.com` page, including `at-main` (or `sess-at-main`). A guest `session-id` without `at-main` pauses before any request.
3. Optionally import a proxy group and run **Test**. A task starts on one proxy from the group. A Walmart task rotates to the next proxy in that group when PerimeterX returns HTTP 412, waits with backoff, and pauses if the block continues.
4. Open **Settings**. Set the Discord webhook (`https://discord.com/api/webhooks/...`), monitor delay, and the Target store ID / ZIP / state used for ship-to-home stock. Send the test webhook to confirm it.
5. Open **Tasks**. Create a task with a Target TCIN (`88897904`) or product URL (`https://www.target.com/p/.../-/A-88897904`), a Walmart item ID (`13816151308`) or product URL (`https://www.walmart.com/ip/.../13816151308`), a Best Buy SKU (`6606082`) or product URL (`https://www.bestbuy.com/product/.../sku/6606082`), a Pokémon Center SKU (`10-10416-112`) or product URL (`https://www.pokemoncenter.com/product/10-10416-112/...`), a Crunchyroll product ID (`810158836396`) or product URL (`https://store.crunchyroll.com/products/...-810158836396.html`), or an Amazon ASIN (`B0C8YN3BY4`) or product URL (`https://www.amazon.com/dp/B0C8YN3BY4`). Check the confirmation box. The checkbox is required before **Start** will run, because a successful monitor places a real order.
6. Press **Start**. The log shows monitoring, add to cart, shipping, payment, and the order id when the retailer accepts it. **Stop** aborts the run. **Resume** continues a paused task after you update the account session.

Every store in the catalog is implemented. A store id registered without a module still fails closed: checkout is not run.

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

## Amazon flow

1. Require a pasted signed-in `www.amazon.com` cookie header that includes `at-main` or `sess-at-main`. Password sign-in is not attempted. A guest cookie header pauses before any request.
2. A bare 10-character ASIN and a `/dp/`, `/gp/product/`, or `/gp/offer-listing/` URL are both accepted. The task requests `https://www.amazon.com/dp/{ASIN}` and then `GET /gp/product/ajax/aodAjaxMain/ref=dp_aod_NEW_mbc?asin={ASIN}&pc=dp`. `/gp/offer-listing/{ASIN}` currently returns HTTP 301 to the product page and drops the offer list, so the task uses the ajax path that still returns the offers.
3. Continue only for an offer whose seller is Amazon.com (seller id `ATVPDKIKX0DER` on that offer, or the sold-by name Amazon.com) and whose shipper is Amazon.com. The marketplace id in the page header is the same token and does not count. Third-party sellers are ignored, including Fulfilled by Amazon (`isAmazonFulfilled=1` with a different seller). When the product page shows a list price, the Amazon.com price has to be at or within 5% of that list price. A higher price stays on the monitor. If Amazon.com sends no list price, Amazon.com's own price is the store price. HTTP 429 and 5xx retry. A "Page Not Found" title stays on the monitor.
4. A robot check (`/errors/validateCaptcha`, "not a robot", "Enter the characters you see", `opfcaptcha`) pauses the task. A two-step verification page (`/ap/mfa`, `/ap/cvf`, "Two-Step Verification") pauses the task. Discord is notified. TCGAIO does not solve captchas or enter OTP codes. A product page that mentions `robotdetection` in a script is not treated as a challenge. A redirect to `/ap/signin` pauses for a fresh cookie header.
5. `POST /cart/add-to-cart/ref=aod_dpdsk_new_0` sends the ASIN, the Amazon.com `offerListingId`, the task quantity, and the `anti-csrftoken-a2z` value from that offer. An unavailable add to cart returns to the monitor.
6. `GET /checkout/entry/cart?proceedToCheckout=1&pipelineType=Chewbacca&referrer=cart` opens checkout. The task does not type a shipping address. It uses the address already selected on the account. A locker, Hub Counter, or pickup destination with no ship-to address fails, and no order is placed. If Amazon asks for a new card or a CVV, the task pauses or fails and does not send the profile card.
7. The place-order form Amazon rendered (`/checkout/p/.../spc/place-order`, or `placeYourOrder1`) is submitted with the fields already on that form. Those fields are the purchase id and the CSRF token. The card number and CVV are not added. A declined saved payment fails without an order id. The order number is the `###-#######-#######` value on the thank-you page.
8. On success, failure, or pause, the app posts to the Discord webhook when one is saved. The checkout page itself was not available during the live read-only check, so the place-order field names are locked by the fake HTTP client.

## Adding a store

Each retailer is a `StoreModule` under `src/stores/<store>/`. The registry in `src/stores/registry.ts` is the only place that needs to know it exists. A module implements `run(ctx)` and returns `success`, `failed`, `paused`, or `stopped`. `ctx` provides the profile, account, the starting proxy, the proxy group, monitor settings, logger, and an HTTP client. Every store in the catalog has a module. `createStubModule` remains the fallback for a catalog id that has no module yet.

## What was tested, and what was not

| Store | Live-verified | Untested live |
| --- | --- | --- |
| Target | Ship-to-home stock JSON through the proxy. Store `1881` ZIP `10001`: TCIN `1012916220` `IN_STOCK`, TCIN `1010892076` `OUT_OF_STOCK`. Store `3991` HTTP 206 digital-store error. Direct requests HTTP 435. | Add to cart, payment, checkout |
| Walmart | Product pages HTTP 200. Sampled Pokémon buy boxes were third-party, not Walmart.com. `GetAllSellerOffers` HTTP 200, then HTTP 412. | Add to cart, sign-in, PIE payment, checkout |
| Best Buy | SKU pages HTTP 200. `6606082` is Best Buy (1P), in-store only, $49.99. Other sampled ETBs were marketplace. | Add to cart, please-wait queue, sign-in, TAS, checkout |
| Pokémon Center | Homepage, search, product, and cart API returned DataDome, Imperva, or Incapsula. No product JSON, price, or stock. | Add to cart, Queue-it, sign-in, Flex, checkout |
| Crunchyroll | `store.crunchyroll.com` HTTP 301 to `https://www.crunchyroll.com/store`. `www` pages and Shopper Products HTTP 403 Cloudflare. No stock JSON. | Add to cart, sign-in, Stripe, checkout |
| Amazon | Product pages and All Offers Display HTTP 200 for the Pokémon ETBs below. None were sold or shipped by Amazon.com. No robot check on these requests. | Add to cart, sign-in, checkout with the saved payment |

Automated tests cover TCIN and proxy parsing, local encryption, masked profiles, the task runner, Discord payload redaction, phone pairing over a direct socket and through the relay, Walmart, Best Buy, Pokémon Center, Crunchyroll, and Amazon session cookies, Walmart PIE ciphertext against a fixed key, a Pokémon Center Flex JWE that decrypts back to the card, a Crunchyroll Stripe PaymentMethod body, Walmart 412 proxy rotation, and the Target, Walmart, Best Buy, Pokémon Center, Crunchyroll, and Amazon sequences against a fake HTTP client: in-stock shipping checkout, a Best Buy please-wait queue, a Pokémon Center Queue-it wait that logs the line position, a wait through an out-of-stock or marketplace reading, a captcha pause before add-to-cart, a declined card, a CVV resubmit, and a 3-D Secure pause that does not call Cardinal. Pokémon Center challenge fixtures are trimmed from live DataDome and Incapsula responses. The Crunchyroll fixture is a trimmed Cloudflare "Just a moment..." page. The Amazon fixture is a trimmed All Offers Display block from the live 151 Elite Trainer Box page. The tests do not call the live sites.

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

The same proxy was used for read-only Amazon requests (undici through the proxy, redirects not followed). ipify was HTTP 200 and the exit IP was `69.85.83.159`. No add to cart, sign-in, or checkout was sent. No purchase was made. None of these offers were sold by Amazon.com, so the monitor treats every one as not in stock. The offer parser matches these All Offers Display bodies. No response was a robot check.

| ASIN | Page | All Offers Display | Amazon.com offer |
| --- | --- | --- | --- |
| B0C8YN3BY4 Pokémon 151 Elite Trainer Box | HTTP 200. Featured seller SSA Cards, $609.99, "Only 13 left in stock". New (14) from other sellers. | HTTP 200. 11 offers, all shipped by the seller. Lowest $609.99 (SSA Cards, Collectors Expedition, DynamaxDeals, Empire of the Senses, AIGDistributionLLC, Thumbs Up Distribution). Then Strawberri Entertainment $699.97, Super Games Inc. $747.97, Bricks a Plenty $799.99, Everstead Supply $851.86, GemMintArena $859.27. | None |
| B0BZQWDLG1 Scarlet & Violet Elite Trainer Box | HTTP 200. The page canonical is B0BSNXK3H7 and shows "See All Buying Options" with no featured merchant. | HTTP 200. Same four sellers as B0BSNXK3H7. | None |
| B0BSNXK3H7 Scarlet & Violet Elite Trainer Box | The B0BZQWDLG1 product page resolved to this ASIN. | HTTP 200. TicTakToys, LegitMTG, and The Gaming Broker $229.95. Ozone Toys $252.95. Each ships from that seller. | None |
| B01N9XCZI7 Sun & Moon Elite Trainer Box | HTTP 200. Featured seller Super Games Inc., $324.97, "Only 2 left in stock". | HTTP 200. Super Games Inc. $324.97, TicTakToys $369.95, BlueProton $499.99. | None |
| B0CLB99P32 | HTTP 404, title "Page Not Found" | not requested |  |
| B078QF8G78 | HTTP 404, title "Page Not Found" | not requested |  |

`/gp/offer-listing/{ASIN}` for B0C8YN3BY4, B0BSNXK3H7, and B01N9XCZI7 was HTTP 301 to `https://www.amazon.com/dp/{ASIN}/ref=olp-opf-redir?aod=1`. That product URL does not include the offer list. `/gp/product/ajax/aodAjaxMain/ref=dp_aod_NEW_mbc?asin={ASIN}&pc=dp` is the request that returned the sellers above.

Amazon add to cart, sign-in, two-step verification, and checkout with the account's saved address and payment were not run live. No card number was sent. The place-order form is covered by the fake HTTP client only.

Target, Walmart, Best Buy, Pokémon Center, Crunchyroll, and Amazon change response shapes, and sign-in or cart calls can be blocked. Expect a paused task until you paste a fresh browser session. Confirm a small in-stock item you actually want before pointing a task at a drop.
