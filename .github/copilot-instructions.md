# TCGAIO

Windows Electron checkout app plus an Expo phone companion. The PC runs checkout. The phone watches and controls tasks. v0.2.7 monitors Target, Walmart, Best Buy, Pokémon Center, Amazon, Crunchyroll, and Premium Bandai (One Piece and other card-shop drops).

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

Monitor sample counts, average time, and block rate are on the analytics report.

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

CI is `.github/workflows/windows.yml`. Pushes to `main` and `cursor/**`, pull requests, and tags `v*` run test, then Windows and Android. The installer, `latest.yml`, blockmap, and APK publish only when the ref is a `v*` tag. Do not move an existing release tag to pick up docs.

Bump versions together when shipping a beta: root `package.json`, `mobile/package.json`, `mobile/app.json` (`version` and `android.versionCode`), `src/shared/version.ts`, `mobile/src/version.ts`, and the version fields in `mobile/package-lock.json`.

## Conventions

- TypeScript. Match the surrounding file. Prefer clear names over new abstractions.
- Comments explain a non-obvious constraint, not the next line.
- Logs and Discord go through `redact` in `src/shared/redact.ts`. Do not log card numbers, CVV, passwords, proxy passwords, or tokens.
- Card data, account passwords, sessions, the Discord bot token, and the GitHub token are encrypted at rest (Windows DPAPI via Electron `safeStorage`, or AES-256-GCM on the key file when DPAPI is unavailable).
- The phone snapshot never includes the card number, CVV, account password, proxy password, or GitHub token. A challenge handoff may include the task cookie header only inside that challenge message.
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
