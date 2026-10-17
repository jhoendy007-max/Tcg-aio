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
- Desktop pages that show a countdown import `src/engine/time`, which re-exports `src/shared/clock.ts`. Do not give the renderer a Node import.
- Drop times are Atlantic Time (Puerto Rico, UTC−4, no daylight-saving shift).
- Electron windows and the updater download path are not unit-tested. Do not claim a live sign-in, captcha solve, or update download from a unit test.

UI copy is a short sentence. Test mode shows a TEST badge. A test run’s log is the checklist from `note()` / `finishTest`.
