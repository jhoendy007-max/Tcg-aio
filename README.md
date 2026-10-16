# TCGAIO

Windows desktop checkout assistant for Pokémon TCG and One Piece TCG drops. v0.1 monitors Target by TCIN, adds the item to your own cart, and places a **ship-to-home** order with a saved profile. Walmart, Best Buy, Pokémon Center, Amazon, and Crunchyroll are registered store modules with checkout still stubbed.

Retailer terms often restrict automated purchasing. TCGAIO uses the account, proxies, and card you provide. It does not send challenges to a solving service. If Target shows a challenge or block, the task pauses and a Discord notification is sent so you can sign in yourself.

## What you get

- **Tasks** — store, SKU or URL, quantity, profile, account, proxy group, start/stop, and a live status log.
- **Profiles** — shipping and billing. Card number and CVV are encrypted locally.
- **Proxies** — import `host:port` or `host:port:user:pass` lists and test them.
- **Accounts** — per-store logins. Passwords and browser sessions are encrypted.
- **Settings** — Discord webhook and Target monitor delay, store ID, ZIP, and state.

On Windows, card numbers, CVVs, passwords, and sessions are encrypted with **Windows DPAPI** through Electron `safeStorage`. If DPAPI is unavailable (for example a Linux dev machine), the app falls back to AES-256-GCM with a key file in the app data folder. The Settings page shows which method is active. Secrets are not written to the task log or the Discord webhook. The card is sent only to `carts.target.com` during payment.

## Requirements

- Windows 10 or 11 to run the packaged app
- Node.js 22 to build from source
- A Target account you control, plus a browser session if password sign-in is challenged

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
2. Open **Accounts**. Add a Target account.
   - Password sign-in is attempted when no session is saved.
   - The reliable path is a browser session. Sign in at target.com, open DevTools, and copy the cookies into the session box:

     ```text
     accessToken=...; visitorId=...; refreshToken=...
     ```

     JSON with `accessToken`, `visitorId`, and `refreshToken` works too.
3. Optionally import a proxy group and run **Test**. Each task sticks to one proxy from the group.
4. Open **Settings**. Set the Discord webhook (`https://discord.com/api/webhooks/...`), monitor delay, and the Target store ID / ZIP / state used for ship-to-home stock. Send the test webhook to confirm it.
5. Open **Tasks**. Create a task with a TCIN (`88897904`) or a product URL (`https://www.target.com/p/.../-/A-88897904`). Check the confirmation box. The checkbox is required before **Start** will run, because a successful monitor places a real order.
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

## Adding a store

Each retailer is a `StoreModule` under `src/stores/<store>/`. The registry in `src/stores/registry.ts` is the only place that needs to know it exists. A module implements `run(ctx)` and returns `success`, `failed`, `paused`, or `stopped`. `ctx` provides the profile, account, proxy, monitor settings, logger, and an HTTP client that already has the task's proxy attached. The Walmart, Best Buy, Pokémon Center, Amazon, and Crunchyroll files are the stubs to replace.

## What was tested, and what was not

Automated tests cover TCIN and proxy parsing, local encryption, masked profiles, the task runner, Discord payload redaction, and the Target sequence against a fake HTTP client: in-stock checkout, out-of-stock then in-stock, a captcha pause before add-to-cart, a declined card, and a CVV resubmit.

A read-only request to Target's fulfillment endpoint from the development network returned HTTP 435 with a PerimeterX captcha payload, so live stock parsing and checkout were not verified. The app treats HTTP 435 and other challenge responses as a pause. A fake saved session against the cart endpoint paused with "session expired" instead of placing an order.

No purchase was made. Target changes API keys and response shapes, and sign-in or cart calls can be blocked. Expect a paused task until you paste a fresh browser session, and treat a monitor payload the parser does not recognize as "not in stock" rather than a checkout. Confirm a small in-stock item you actually want before pointing a task at a drop.
