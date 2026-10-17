---
applyTo: "src/main/**,src/preload/**,src/renderer/**"
---

# Desktop

Electron 33. Main process in `src/main`, preload bridge in `src/preload`, React renderer in `src/renderer`. The packaged entry is `out/main/index.js`.

- IPC channels live in `src/shared/ipc.ts`. Add a channel in the preload types and the main handler together. The renderer uses the preload API, not `require("electron")`.
- `src/main/index.ts` owns the single-instance lock, cipher, database, task runner, phone server, alerts, Session Keeper timer, drop timer, and auto-update.
- Secrets stay in the main process. The renderer sees public profiles (last4, not the card number) and public accounts.
- Session Keeper and the challenge handoff open a `BrowserWindow` with the account partition `persist:account-${id}`. Set the task proxy on that session. Answer proxy auth only when `authInfo.isProxy` is true. Do not put the proxy password in the renderer or the phone protocol.
- Closing the challenge window does not submit. The user presses **I solved it**. One resume per task start. A second challenge pauses.
- Auto-update uses `electron-updater` against this private GitHub repo, prereleases included, `autoDownload` false. The token is encrypted and is not returned to the renderer or the phone. `dist:win` uses `--publish never`. The tag workflow uploads the exe, `latest.yml`, and blockmap.
- Ship the desktop app for Windows only. Do not add an electron-builder `mac` target, a dmg, a macOS CI job, or Mac signing.
- Autopilot, spend limits, boot launch, and the daily report live in Settings and the Autopilot page. Place-order requests stay behind `isFinalSubmit`. A budget or quantity limit throws before that request is sent.
- Tasks are either a monitor or a checkout. A monitor can link several checkouts. A checkout starts manually, on a drop, from a monitor, from a restock alert, or with its own monitor. Safe fields (delays, caps, hours, links, webhook) save while the task is running. Store, SKU, account, proxy, and payment consent wait until it is stopped. English and Spanish follow the language control. A task override still wins over the store page, which wins over global Settings.
- GameStop, Barnes & Noble, Costco, and Sam's Club watch the product page and do not add to cart. TCGplayer Direct watches the public catalog. Pokémon Center and Premium Bandai remain the official US preorder modules.
- Analytics Resale reads public TCGplayer and eBay prices and drafts a listing. It does not post the listing. Inventory lists successful purchases, a saved current value, profit, and a CSV export.
- Encrypted backup downloads a `.tcgaio-backup` file or PUTs that ciphertext to the user's https URL. The passphrase and upload token are not written into the file. Restore does not replace this PC's phone pairings.
- Stores has one settings page per store. Recommended defaults are editable, Reset restores them, and a task override wins over the store page, which wins over global Settings. The page shows where the value comes from. Presets export and import as JSON. English and Spanish follow the language control.
- Mail lives in Settings. An email address fills the host, port, and SSL. Google and Microsoft can sign in with a public client ID (PKCE, XOAUTH2, no client secret). iCloud and Yahoo use an app password and the official setup links. Failures are short English or Spanish sentences. The client only reads mail and only from store sender domains. It does not send mail. The Autopilot page does not edit mailboxes.
- Session Sync is the Vault page. It lists linked browsers, expiry, and last used. It never receives the cookie. Turning two-way on lets the extension pull a session this PC already saved. The health check flags expiry; it does not sign the user in.
- Desktop pages that show a countdown import `src/engine/time`, which re-exports `src/shared/clock.ts`. Do not give the renderer a Node import.
- Drop times are Atlantic Time (Puerto Rico, UTC−4, no daylight-saving shift).
- Electron windows and the updater download path are not unit-tested. Do not claim a live sign-in, captcha solve, or update download from a unit test.

UI copy is a short sentence. Test mode shows a TEST badge. A test run’s log is the checklist from `note()` / `finishTest`.

Home is the default page. Appearance (theme, accent, app name, logo, success sound, task density) is saved with the other settings. The setup wizard runs only for an empty vault that has not finished setup. Store marks are letter tiles. A product photo is the https image already in the monitor response, or an optional https URL on the task. Do not guess a CDN URL or copy a store logo. The task row shows the last monitor time in milliseconds. Monitor-only tasks never cart. Analytics shows p50, p95, and the stock-change log.
