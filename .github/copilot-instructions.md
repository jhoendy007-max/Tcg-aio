# TCGAIO

Windows Electron checkout app plus an Expo phone companion. The PC runs checkout. The phone watches and controls tasks. v0.2.21-beta checks out Target, Walmart, Best Buy, Pokémon Center, Amazon, Crunchyroll, Premium Bandai, GameStop, Barnes & Noble, Costco, Sam's Club, and TCGplayer Direct. Account tasks stay on that account's persistent Chromium profile and one sticky proxy.

Retailer terms often restrict automated purchasing. Use only an account, proxy, and card the user provides.

## Layout

- `src/main` — Electron main process: window, IPC, encrypted database startup, phone server, Session Keeper window, challenge window, auto-update.
- `src/preload` — typed bridge to the renderer. Do not expose Node or secrets here.
- `src/renderer` — React UI (tasks, profiles, accounts, proxies, alerts, keeper, drops, analytics, settings, phone pairing).
- `src/engine` — task runner, undici HTTP, SQLite-style database, test mode, session care, alerts, drops, analytics, releases. Node only.
- `src/stores` — one module per retailer. `registry.ts` wires them.
- `src/shared` — types, store catalog, clock, version, redaction. Safe for the phone bundle.
- `src/phone` — AES-256-GCM protocol, desktop WebSocket server, optional ciphertext relay. Metro may bundle this folder.
- `mobile/` — Expo app. Its own `package.json`. Imports `../src/phone` and `../src/shared` only.
- `extension/` — Chrome and Edge Manifest V3 Session Sync. It pairs as another phone device. It does not import the engine.
- `tests/` — Vitest. Fixtures live in `tests/fixtures`.

`mobile/metro.config.js` watches only `../src/phone` and `../src/shared`. Do not import `src/engine` from the phone. The engine uses undici and Node. Countdown text lives in `src/shared/clock.ts`. `src/engine/time.ts` re-exports it for the desktop.

## Store module

A store implements `StoreModule` in `src/stores/module.ts`: `id`, `displayName`, `skuHint`, `implemented`, and `run(ctx)`.

`run` returns `success`, `failed`, `paused`, `stopped`, or `tested`. The task runner owns retries, jitter, backoff, challenge handoff, and the test-mode HTTP guard. A module reports a retry by returning to its monitor loop and calling `ctx.sleep`. It does not place the order inside test mode.

To add a store:

1. Add the id to `STORE_IDS` in `src/shared/types.ts` and a catalog row in `src/shared/stores.ts`.
2. Implement `src/stores/<id>/` and register it in `src/stores/registry.ts`.
3. Add the place-order request to `isFinalSubmit` in `src/engine/test-mode.ts`. Payment tokenization is not a final submit.
4. Set the polite gap, Session Keeper home, challenge host and page, health probe, listing search, and bulk/restock parsers.
5. Add fixtures and tests. A missing session must not call the store. A guest session must not add to cart. Test mode must end as `tested` and must not call the place-order URL.

GameStop, Barnes & Noble, Costco, and Sam's Club read the product page with the saved session cookies. Purchasable means schema.org InStock, LimitedAvailability, PreOrder, or PreSale, or a visible Add to Cart control. A challenge page pauses for a person. Checkout posts only to a form action on that store's host, using the fields and CSRF token the page already included. If the in-stock page has no same-host add-to-cart form, the task pauses and the user adds it in the account browser. Address, shipping, and payment steps come from later forms on that same host. A saved card shown on the page is selected. The card number is posted only to a tokenization form the page itself links on that host. If neither exists, checkout pauses and the card is not sent. Place order is only the form action `isFinalSubmit` already names, and test mode returns `tested` before that POST. A page price above the task max, or a spend-limit refusal, does not add to cart. Costco's product JSON often says OutOfStock when the page is only a default. No add control means the task keeps watching, and the log does not invent a warehouse count. Do not call `ecom-api.costco.com`, follow a redirect off the store host, or replay a client id from the page bundle. Do not forge sensor data, cookies, or a TLS fingerprint.

TCGplayer Direct uses the public catalog: GET `mp-search-api.tcgplayer.com/v1/product/{id}/details` and POST that host's `/listings` search. A missing session may still make those catalog requests. Direct stock means `directListing` or `directInventory` on a listing with quantity. A Direct-enrolled seller with neither is not Direct stock. Sold by any seller accepts any listing with quantity. Checkout needs the saved www.tcgplayer.com session and a cart form on that host. The catalog host still refuses cart, checkout, and place-order paths. Keyword search stays a GET of the public search URL. Do not reverse the cart microfrontend or invent a cart POST.

Official US Pokémon Center preorders stay on the Pokémon Center module (`PRE_ORDER` / `PREORDER` are buyable). Official Premium Bandai preorders, including One Piece card-shop drops, stay on the Premium Bandai module (`PRE_ORDER` and `preOrderStatus` InProgress). Do not add a second store for those. Japan Pokémon Center is out of scope.

## Resale

Analytics has a Resale card for a recorded win. It GETs the public TCGplayer catalog when the user supplies a product id, and GETs the public eBay sold search for the product name. Profit is unit price times quantity, minus the cost the user entered, minus a fee percent the user entered. Zero fee percent does not invent marketplace fees. The card drafts a listing and can copy it. It does not POST to eBay, TCGplayer, or any other marketplace. A challenge page returns no prices.

Inventory lists successful checkouts. Cost is the recorded price. Current value is a number the user saves on that purchase. Profit is value minus cost, and the total profit counts only purchases that have a value. Test runs are not purchases. Export writes `tcgaio-inventory.csv`. It does not fetch a live price for every row.

## Backup

Settings can export a `.tcgaio-backup` file sealed with a passphrase the user types and TCGAIO does not save. PBKDF2-SHA256 (210000 iterations) derives an AES-256-GCM key. The file and an optional https PUT are ciphertext only. The document inside holds settings, tasks, profiles (including cards), accounts (including passwords and sessions), proxy groups, schedules, and templates. It does not hold phone device tokens or the backup upload token. Restore keeps this PC's id, paired phones, upload token, and checkout history, and re-encrypts secrets with this PC's cipher. The backup URL is https with no userinfo and no query string. A redirect is not followed. One phone can store several PC pairings and switch which PC it controls. Forgetting a PC, or a revoked pairing, removes that PC only. `PHONE_PROTOCOL` stays 1.

## Licenses

Licensing is off until `licenseRequired` is turned on. A seller PC creates an Ed25519 identity. The public key is copied to other PCs. The private key stays encrypted on the seller PC and is not in a backup, the phone snapshot, or a license request. Minted keys are signed tokens. Activation sends only the key, this PC's id, and the app version. A license server response that includes a card, password, cookie, or session is rejected and not stored. Seat limits are enforced by the optional server. The local server binds to 127.0.0.1. A remote server URL must be https. Redirects are not followed. Task start is refused when a license is required and this PC is not activated. This is optional seat tracking for selling or sharing. It does not add anti-bot behavior.

## Group Discord

`groupDiscord` is off by default. The group webhook is separate from the personal webhook. When it is on, an in-stock restock or keyword alert and a successful checkout are posted there. Failures, tests, pauses, and challenges stay on the personal webhook only. The group post drops the profile name and strips emails, card numbers, CVVs, passwords, tokens, and proxy userinfo. It does not post a listing to a marketplace.

Shipping state is a two-letter US code from `src/engine/validate.ts`. Puerto Rico is not in that set. ZIP is `^\d{5}(?:-\d{4})?$`.

## Monitor

Stock checks go through `MonitorHub` in `src/engine/monitor.ts`. Tasks watching the same store, SKU, location, and proxy share one in-flight request. The lightest endpoint already used by each module stays the monitor read: Target Redsky JSON, Walmart seller-offers GraphQL (the product page is only a fallback), Pokémon Center search JSON, Crunchyroll and Premium Bandai product JSON, Amazon’s offer fragment before the full product page, and Best Buy’s product or search page. Do not add a second request that this network cannot confirm.

Outside a drop window the wait is `monitorDelayMs`. Inside a user window (`HH:MM-HH:MM` Atlantic Time) or a scheduled drop, it is `monitorFastDelayMs`, then jitter, and never under the store gap in `src/engine/polite.ts`.

Target repeats the Redsky read for each configured ZIP and store id (at most four). Walmart, Amazon, Best Buy, Pokémon Center, Crunchyroll, and Premium Bandai keep the signed-in or national location. Do not invent a location cookie.

A stock reading can notify on price, new offer id, unavailable-to-purchasable, and retailer-offer changes. The first reading is a baseline. Two restocks in the same Atlantic hour suggest a 15-minute Session Keeper warm-up.

`monitorProxyGroupId` is the stock-check pool. `proxyGroupId` is checkout. Blank monitor pool uses the checkout pool for both.

A block (HTTP 403, 412, 429, or 435, except a real product queue) backs off, rotates within the current pool, and reloads the account browser to copy cookies the site set. After `blockRetries` the task pauses. Place-order requests are not retried. A person still solves a challenge in the existing handoff. Do not open a second solver.

Each stock read records DNS, connect, time to first byte, and total milliseconds for that store and proxy. Analytics shows the average, p50, and p95. The task row shows the last read in milliseconds and, when a cart request follows an in-stock reading, the milliseconds from detection to add-to-cart. `npm run bench:monitors -- --n 5` repeats those read-only GETs and prints p50, p95, and success rate. `--proxy host:port` sends them through one proxy. The HTTP client keeps a connection pool per proxy and allows HTTP/2. A drop warm-up opens those monitor URLs before the window. Do not add a custom TLS fingerprint or a trace header.

A monitor-only task never adds to cart. It can start without purchase confirmation. Alerts can create one from a rule or a match. Product images come from the product JSON or og:image already in that response, then from an optional https URL on the task. Discord embeds include price, stock, link, and that image. The phone notice can show the same image. Stock changes (restock, sell-out, price) are on the analytics report.

Monitor sample counts, average time, p50, p95, and block rate are on the analytics report.

## Hands-free

Autopilot is off until the user turns it on. A saved template can create and start a task from a restock alert, a keyword hit, or a learned restock hour. Price caps skip a signal that has no price. Rotation uses only accounts and profiles saved on that PC, and it stops when the daily, drop, SKU, account, or per-store quantity limit is reached.

Those limits are checked again in the task HTTP client before a place-order request. Test mode still throws before that request is sent. A limit pause does not retry the order.

Self-healing runs only while autopilot is on. A task with no log for `stuckMinutes` is restarted up to three times. An expired session opens Session Keeper once, then the task can move to another saved account for the same store. A benched proxy is replaced from the same pool. If every proxy in the pool is benched, the task pauses.

Windows launch at boot is opt-in (`launchOnBoot`). A clean quit marks running tasks stopped. A crash leaves them active, and the next launch resumes them when `resumeOnLaunch` is on. An uncaught error can relaunch the process at most once a minute.

Order rows are stored after a win. A later GET of that account's order page, plus mail from Settings, can mark the order cancelled or record a tracking number.

## Tasks

A task is either a monitor or a checkout. `src/shared/task-role.ts` is the source of that split. An older task with `monitorOnly` set loads as a monitor. Every other older task loads as a checkout with start mode `builtin`, which is the previous watch-then-cart loop.

A monitor stores the SKU or URL, keywords, monitor and retry delays, jitter, proxy group, ZIP, price cap, sold-by filter, webhook, active hours, and the checkout tasks it may start. It never adds to cart: `monitorOnly` stays true, confirm purchase stays off, and the profile and account are cleared. Active hours are Atlantic time (`America/Puerto_Rico`), one `09:00-09:30` window per line. A blank list means always. One monitor can start many checkouts whose start mode is `monitor` and whose id is linked.

A checkout stores the SKU or URL, quantity, profile, account, checkout proxy group, checkout delay, retry delay, max retries, add-to-cart mode, test mode, and max price. Start mode is `manual`, `scheduled`, `monitor`, `restock`, or `builtin`. `builtin` runs the checkout's own monitor when the user starts it. `scheduled` waits for a drop. `monitor` waits for the linked monitor. `restock` starts when an in-stock alert matches the SKU, or the keywords when the SKU differs. Max price is checked again before a place-order request. Test mode still refuses that request.

Delays, jitter, ZIP, sold-by, add-to-cart mode, and max retries stay in `overrides`, so the task wins over the store page, which wins over global Settings. Global test mode still forces every checkout to stay a test. While a task is running, store, SKU, type, profile, account, proxy, quantity, start mode, turning confirm purchase on, and turning test mode off are rejected. Keywords, caps, hours, links, webhook, checkout delay, jitter, and overrides can change and the running loop reads them on the next sleep. Bulk edit follows the same split. Duplicate copies the role onto a new idle task.

The desktop Tasks page and the phone editor both follow `Settings.language` (`en` or `es`). `PHONE_PROTOCOL` stays 1. A monitor draft may omit the profile and account.

## Store settings

Each store in `STORE_CATALOG` has a settings page. Recommended defaults live in `src/shared/module-settings.ts` and match that store's request gap. A task `overrides` field wins, then the saved store page, then global Settings when the field is set to use the global value. An unsaved field shows as recommended. Global test mode stays on for every task. The rate limit cannot go under `MODULE_RATE_FLOOR`, which matches `STORE_GAP_MS`. Reset clears that store's saved page. Import and export are a version-1 JSON preset for one store. The same page is on the phone. The store page follows `Settings.language` (`en` or `es`). `PHONE_PROTOCOL` stays 1. A new store needs a recommended row and a rate floor before its page will compile.

## Mail

Settings stores several IMAP mailboxes. Typing an email address fills the host, port, and SSL from the domain (Gmail, Outlook, iCloud, Yahoo, or a guessed `imap.` host). Gmail and Outlook can use Sign in with Google or Sign in with Microsoft: a public desktop client ID stored in Settings, PKCE on `127.0.0.1`, and IMAP `AUTHENTICATE XOAUTH2`. There is no client secret. The refresh token is encrypted like the other secrets. iCloud and Yahoo stay on an app password, with numbered steps and links only to the official account pages. A failed test is stored as a short English or Spanish sentence. The mail screens follow `Settings.language` (`en` or `es`).

Access is read-only. Do not APPEND, STORE, EXPUNGE, COPY, or MOVE, and do not send mail. A message counts only when its From domain is one of that store's sender domains in `src/shared/mail.ts`. Sign-in codes are filled into the user's own account during session refresh, or posted only when Amazon's page already has an OTP form. The digits are not written to the log, Discord, or the phone. Order mail updates tracking. Restock and newsletter mail is an optional alert and does not start checkout. The phone can add a mailbox, start the desktop sign-in, and shows status without the password or refresh token. `PHONE_PROTOCOL` stays 1.

The daily report uses `healthReportTime` in `healthReportZone` (the host zone when the field is blank) and goes to Discord and the phone.

The phone can set autopilot and pause every running task. The desktop app stays Windows-only. Do not add a macOS disk image, macOS CI, or Mac signing. The phone keeps the TestFlight path in `mobile/eas.json`.

## Session Sync

`extension/` is a Manifest V3 extension named TCGAIO Session Sync. It pairs with the same one-time QR the Phone page already shows, over the local WebSocket, and keeps a per-device token. Revoke that device on the desktop and the token stops working.

Host permissions are only the store sites in the catalog. The user links each account explicitly. The extension reads cookies, and the allowlisted localStorage keys in `extension/policy.mjs`, only for a linked account. A push is stored with `updateSession(..., quiet)` so it does not echo back. Two-way is off until the user turns it on. A two-way pull or `vault.session` writes cookie pairs the desktop already saved. It does not invent cookie names.

The desktop Session Sync page shows expiry, last used, and a flag. It does not show the cookie. A one-minute check uses the saved expiry. It does not open store login pages. Logged-out and expiring-soon notices go to Discord and the phone at most once per day. The cookie never goes in the phone snapshot or a broadcast to every device.

## Session consistency

Account tasks run in that account's persistent Chromium partition `persist:account-${id}`, the same profile Session Keeper and hidden refresh already use. Cookies written into it are only ones Session Sync or the store already set. Do not launch the user's Chrome user-data directory, and do not spoof or randomize TLS, JA3, the browser, canvas, or a device fingerprint. Do not forge anti-bot sensors or cookies.

Each account has one sticky proxy, not shared with another account. A checkout does not rotate off it. The next task start may pick another proxy only after that proxy is quarantined. Quarantine is three HTTP 403, 412, or 435 responses, then a 30 minute cooldown. HTTP 429 stays a block for pacing and does not quarantine. The Proxies page shows a 0–100 health score. Tasks with no account may pick their own proxy and may move after a block. The task table and editor show the effective account, proxy, and browser profile, and where each came from. A task proxy group that would replace the account's sticky proxy is a warning, not a switch. Pacing, jitter, retries, max price, and test mode stay on the task, with task over store over global Settings.

Requests that share an account or a proxy share one polite clock per store. The gap is that task's rate limit, never under the store floor, plus that task's jitter. Optional warm-up, when Session Keeper is on, browses the store homepage and checks the sign-in in the days before a drop. It does not add to cart. Near-expiry sessions refresh across the last few minutes before the drop. Hidden session windows are capped (Settings, default 3) and the rest wait. The captcha phone handoff is unchanged.

Residential proxies the user controls are the right pool. Datacenter addresses are challenged more often. TCGAIO does not hide TLS to compensate.

Do not harvest other sites, share a session with another user, or forge cookies. `scripts/pack-extension.mjs` writes `release/TCGAIO-Session-Sync-<version>.zip` (manifest at the zip root) and a `.crx` around that zip. The private key is not written. Load unpacked is the install path. A `v*` tag publishes the zip next to the Windows installer and the release APK.

## Front end

Home is the first page. It shows active tasks, today's checkouts, spend, success rate, proxy bench state, and session saved/expired/missing. The task table can search, filter, group by drop label, and reorder. Compact and detailed are a setting. Store marks are original letter tiles, not retailer logos. A product photo appears only when the task has an https image URL the user entered.

Theme, accent, app name, and an optional logo live in Settings. The logo is a small PNG, JPEG, or WebP data URL. Success sound is off until the user turns it on. The confirmation overlay opens when a task moves to success or tested. Checkout spend and the order number come from the saved checkout row.

The first-run wizard shows only when setup is unfinished and there are no profiles and no accounts. Skip marks setup finished. The wizard's first task is test mode with confirm purchase off.

The phone uses the same colors from the snapshot `brand` field. That field does not include the logo. Swipe actions sit beside the visible Start, Stop, and Test buttons. The Android home widget (wins and active tasks) is added by `mobile/plugins/withWidgets.js` during prebuild. There is no iOS widget target in this beta: the Xcode project is not checked in, and an untested WidgetKit extension could break the TestFlight build.

## Commands

From the repo root, with Node 22:

- `npm ci`
- `npm test` — Vitest
- `npm run typecheck` — `tsc -p tsconfig.node.json` and `tsc -p tsconfig.web.json`
- `npm run dev` — Electron with a reloading UI
- `npm run build` — unpacked app in `out/`
- `npm run dist:win` — NSIS installer in `release/`. Passes `--publish never`.
- `npm run phone:relay` — local ciphertext relay

Phone:

- `cd mobile && npm ci && npm run typecheck`
- `npm run android:release` — signed release APK via `mobile/scripts/assemble-release.sh`

Use the local binaries (`./node_modules/.bin/tsc`, `./node_modules/.bin/vitest`) from the repo root. Do not run `npx tsc` from another directory.

CI is `.github/workflows/windows.yml`. Pushes to `main` and `cursor/**`, pull requests, and tags `v*` run test, then Windows and Android. The installer, `latest.yml`, blockmap, APK, Session Sync zip, and `release-assets/desktop-home-tasks-phone-tour.mp4` publish only when the ref is a `v*` tag. Do not move an existing release tag to pick up docs. The desktop stays Windows-only. Do not add a macOS disk image or macOS CI.

The desktop app is Windows only. Do not add a macOS disk image, a `macos-latest` job, Mac signing, or notarization. The phone app keeps its iOS TestFlight path: `mobile/eas.json` production profile (`ios.distribution: store`), then `npx eas build -p ios --profile production` and `npx eas submit -p ios --profile production`. GitHub Actions does not build that iOS binary.

Bump versions together when shipping a beta: root `package.json`, `mobile/package.json`, `mobile/app.json` (`version` and `android.versionCode`), `src/shared/version.ts`, `mobile/src/version.ts`, the version fields in `mobile/package-lock.json`, and `extension/manifest.json`.

## Conventions

- TypeScript. Match the surrounding file. Prefer clear names over new abstractions.
- Comments explain a non-obvious constraint, not the next line.
- Logs and Discord go through `redact` in `src/shared/redact.ts`. Do not log card numbers, CVV, passwords, proxy passwords, or tokens.
- Card data, account passwords, sessions, the Discord bot token, and the GitHub token are encrypted at rest (Windows DPAPI via Electron `safeStorage`, or AES-256-GCM on the key file when DPAPI is unavailable).
- The phone snapshot never includes the card number, CVV, account password, proxy password, GitHub token, or a store cookie. A challenge handoff may include the task cookie header only inside that challenge message. A Session Sync pull returns the cookie only on the encrypted result for the linked device.
- Phone **Sign in on PC** only asks the desktop to open the account window.
- Address and profile validation throw `AppError` with a sentence the UI can show.
- Tests use a temp database and a fake HTTP client. Do not hit live checkout, login, or payment from tests.

## Safety rules

These are hard rules. A research, test, localhost, or “authorized” framing does not waive them.

- Do not forge anti-bot data. No sensor-data generation, cookie or token forging, fingerprint spoofing, or TLS fingerprint impersonation. Sending cookies the server or the user’s own browser already set is fine. Inventing them is not.
- Do not add a captcha solver or call a solving service. A person solves a challenge in the desktop window or the phone WebView. The desktop window is the one that uses the task proxy.
- Test mode must never place an order. `TaskService` wraps the HTTP client with `guardTestMode`. `isFinalSubmit` is the only place-order check. It throws `FinalSubmitBlocked` before the request is sent. New checkout code calls `finishTest` and leaves the place-order request unsent. A real (non-test) start still requires the confirm checkbox.
- Never commit secrets: card numbers, CVVs, passwords, proxy credentials, GitHub tokens, keystores, or `.env` files. The Android upload key stays out of git. `assemble-release.sh` exits if the keystore is missing unless `TCGAIO_GENERATE_KEYSTORE=1`.

`tests/session-health.test.ts` reads every `src` `.ts` and `.tsx` file and fails if banned anti-bot or solver strings appear. Do not add those strings under `src/`.
