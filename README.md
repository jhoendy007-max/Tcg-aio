# TCGAIO

Windows desktop checkout assistant for Pokémon TCG and One Piece TCG drops. v0.1 monitors Target by TCIN and Walmart by item ID, adds the item to your own cart, and places a **ship-to-home** order with a saved profile. Best Buy, Pokémon Center, Amazon, and Crunchyroll are registered store modules with checkout still stubbed.

Retailer terms often restrict automated purchasing. TCGAIO uses the account, proxies, and card you provide. It does not send challenges to a solving service. If Target or Walmart shows a challenge or block, the task pauses and a Discord notification is sent so you can sign in yourself.

## What you get

- **Tasks** — store, SKU or URL, quantity, profile, account, proxy group, start/stop, and a live status log.
- **Profiles** — shipping and billing. Card number and CVV are encrypted locally.
- **Proxies** — import `host:port` or `host:port:user:pass` lists and test them.
- **Accounts** — per-store logins. Passwords and browser sessions are encrypted.
- **Settings** — Discord webhook and Target monitor delay, store ID, ZIP, and state.

On Windows, card numbers, CVVs, passwords, and sessions are encrypted with **Windows DPAPI** through Electron `safeStorage`. If DPAPI is unavailable (for example a Linux dev machine), the app falls back to AES-256-GCM with a key file in the app data folder. The Settings page shows which method is active. Secrets are not written to the task log or the Discord webhook. The card is sent only to `carts.target.com` during Target payment, and only to `www.walmart.com` during Walmart payment.

## Requirements

- Windows 10 or 11 to run the packaged app
- Node.js 22 to build from source
- A Target or Walmart account you control, plus a browser session if password sign-in is challenged

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
2. Open **Accounts**. Add a Target or Walmart account.
   - Target password sign-in is attempted when no session is saved. Walmart password sign-in is not attempted, because PerimeterX blocks it.
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
3. Optionally import a proxy group and run **Test**. Each task sticks to one proxy from the group.
4. Open **Settings**. Set the Discord webhook (`https://discord.com/api/webhooks/...`), monitor delay, and the Target store ID / ZIP / state used for ship-to-home stock. Send the test webhook to confirm it.
5. Open **Tasks**. Create a task with a Target TCIN (`88897904`) or product URL (`https://www.target.com/p/.../-/A-88897904`), or a Walmart item ID (`13816151308`) or product URL (`https://www.walmart.com/ip/.../13816151308`). Check the confirmation box. The checkbox is required before **Start** will run, because a successful monitor places a real order.
6. Press **Start**. The log shows monitoring, add to cart, shipping, payment, and the order id when Target accepts it. **Stop** aborts the run. **Resume** continues a paused task after you update the account session.

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
2. Poll the persisted `GetAllSellerOffers` query for every seller of that item. A product-page `__NEXT_DATA__` read is the fallback when that call returns no product payload. HTTP 412, 418, and 456, a "Robot or human?" page, and press-and-hold pause the task. The word PerimeterX on a normal product page does not. HTTP 429 and 5xx retry on the monitor delay.
3. Continue only for an offer sold by Walmart.com itself (`sellerType` `INTERNAL`, `catalogSellerId` 0, or the seller name Walmart.com) with ship-to-home stock at or below the list or was price. Third-party sellers are ignored, including Fulfilled by Walmart. A marketplace listing, a Walmart.com price above that reference, pickup-only stock, and a missing item keep the monitor running.
4. `updateItems` adds the Walmart.com offer. Fulfillment is set to `SHIPPING`. Pickup is not requested.
5. `CreateDeliveryAddress` saves the profile address without making it the account default, then `setShipping` attaches it to the cart.
6. `CreateAccountCreditCard` sends the profile card only to `www.walmart.com`. Walmart's live site encrypts cards with PIE before this call. v0.1 does not generate that encryption, so this step is untested against Walmart and can be rejected until a browser session already has a saved card that the mutation accepts.
7. `CreateBuyNowContract` opens one contract for that offer, then `placeOrder` submits it. If Walmart asks for the CVV again, the card is resubmitted once and place order is retried. Only `placeOrder` is the charge. After a success response, the cart line is set to quantity 0 so it is not bought again later.
8. On success, failure, or pause, the app posts to the Discord webhook when one is saved.

## Adding a store

Each retailer is a `StoreModule` under `src/stores/<store>/`. The registry in `src/stores/registry.ts` is the only place that needs to know it exists. A module implements `run(ctx)` and returns `success`, `failed`, `paused`, or `stopped`. `ctx` provides the profile, account, proxy, monitor settings, logger, and an HTTP client that already has the task's proxy attached. The Best Buy, Pokémon Center, Amazon, and Crunchyroll files are the stubs to replace.

## What was tested, and what was not

Automated tests cover TCIN and proxy parsing, local encryption, masked profiles, the task runner, Discord payload redaction, Walmart session cookies, and the Target and Walmart sequences against a fake HTTP client: in-stock shipping checkout, a wait through an out-of-stock or marketplace reading, a captcha pause before add-to-cart, a declined card, and a CVV resubmit.

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

No Walmart.com listing was in those buy boxes. The 41-offer payload was counted, then the proxy was challenged with HTTP 412 before a second full seller list was saved, so it is unconfirmed whether any of those 41 sellers was Walmart.com. Add to cart, sign-in, and checkout were not run against live Walmart. No purchase was made.

Target and Walmart change response shapes, and sign-in or cart calls can be blocked. Expect a paused task until you paste a fresh browser session. Confirm a small in-stock item you actually want before pointing a task at a drop.
