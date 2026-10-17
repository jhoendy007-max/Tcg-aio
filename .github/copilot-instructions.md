# TCGAIO

Windows Electron checkout app plus an Expo phone companion. The PC runs checkout. The phone watches and controls tasks. v0.2.11 monitors Target, Walmart, Best Buy, Pokémon Center, Amazon, Crunchyroll, and Premium Bandai (One Piece and other card-shop drops).

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

## Mail

Settings stores several IMAP mailboxes. Typing an email address fills the host, port, and SSL from the domain (Gmail, Outlook, iCloud, Yahoo, or a guessed `imap.` host). Gmail and Outlook can use Sign in with Google or Sign in with Microsoft: a public desktop client ID stored in Settings, PKCE on `127.0.0.1`, and IMAP `AUTHENTICATE XOAUTH2`. There is no client secret. The refresh token is encrypted like the other secrets. iCloud and Yahoo stay on an app password, with numbered steps and links only to the official account pages. A failed test is stored as a short English or Spanish sentence. The mail screens follow `Settings.language` (`en` or `es`).

Access is read-only. Do not APPEND, STORE, EXPUNGE, COPY, or MOVE, and do not send mail. A message counts only when its From domain is one of that store's sender domains in `src/shared/mail.ts`. Sign-in codes are filled into the user's own account during session refresh, or posted only when Amazon's page already has an OTP form. The digits are not written to the log, Discord, or the phone. Order mail updates tracking. Restock and newsletter mail is an optional alert and does not start checkout. The phone can add a mailbox, start the desktop sign-in, and shows status without the password or refresh token. `PHONE_PROTOCOL` stays 1.

The daily report uses `healthReportTime` in `healthReportZone` (the host zone when the field is blank) and goes to Discord and the phone.

The phone can set autopilot and pause every running task. The desktop app stays Windows-only. Do not add a macOS disk image, macOS CI, or Mac signing. The phone keeps the TestFlight path in `mobile/eas.json`.

## Session Sync

`extension/` is a Manifest V3 extension named TCGAIO Session Sync. It pairs with the same one-time QR the Phone page already shows, over the local WebSocket, and keeps a per-device token. Revoke that device on the desktop and the token stops working.

Host permissions are only the seven store sites. The user links each account explicitly. The extension reads cookies, and the allowlisted localStorage keys in `extension/policy.mjs`, only for a linked account. A push is stored with `updateSession(..., quiet)` so it does not echo back. Two-way is off until the user turns it on. A two-way pull or `vault.session` writes cookie pairs the desktop already saved. It does not invent cookie names.

The desktop Session Sync page shows expiry, last used, and a flag. It does not show the cookie. A one-minute check uses the saved expiry. It does not open store login pages. Logged-out and expiring-soon notices go to Discord and the phone at most once per day. The cookie never goes in the phone snapshot or a broadcast to every device.

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

CI is `.github/workflows/windows.yml`. Pushes to `main` and `cursor/**`, pull requests, and tags `v*` run test, then Windows and Android. The installer, `latest.yml`, blockmap, APK, and Session Sync zip publish only when the ref is a `v*` tag. Do not move an existing release tag to pick up docs.

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
