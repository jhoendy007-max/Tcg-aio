---
applyTo: "mobile/**,src/phone/**,src/shared/**"
---

# Phone

The Expo app in `mobile/` talks to the desktop over the protocol in `src/phone`. Frames are AES-256-GCM. `PHONE_PROTOCOL` is 1. The QR invite lasts three minutes and is single use. The device token is stored in Expo SecureStore. The relay (`npm run phone:relay`) forwards ciphertext only.

Metro `watchFolders` are `../src/phone` and `../src/shared` only. A phone file must not import `src/engine`, `src/main`, `src/stores`, or `src/renderer`. Shared code that the phone imports cannot import undici, Electron, or `node:`.

The snapshot and task messages omit the card number, CVV, account password, proxy password, GitHub token, and store cookies. The challenge message may carry the task cookie header so a person can solve the page. A `vault.session` frame is for the Session Sync extension only, and only when that device turned two-way on. The phone WebView cannot set a per-WebView proxy and only sees cookies JavaScript can read. **Sign in on PC** and **Open on PC** ask the desktop to open its window.

`mobile/src/version.ts` `PHONE_VERSION` matches `src/shared/version.ts` and `mobile/package.json`. `android.versionCode` in `mobile/app.json` increases for every release APK so it can install over the previous release build. The 0.2.0 debug APK used another signature and must be uninstalled first.

Do not copy engine modules into `mobile/` to get around Metro. Move the shared piece into `src/shared` instead.

Release APK: `mobile/scripts/assemble-release.sh`. It restores the existing upload keystore (`CN=TCGAIO Phone`). A missing keystore is a failure, not a prompt to mint a new one, unless `TCGAIO_GENERATE_KEYSTORE=1`.

iOS stays TestFlight-ready. `mobile/eas.json` production sets `ios.distribution` to `store`. From `mobile/`, `npx eas build -p ios --profile production` then `npx eas submit -p ios --profile production`. Keep the `preview` profile. Do not add a macOS desktop build from this app.

The task editor creates a monitor or a checkout. A monitor can omit the profile and account and can link checkout tasks. A checkout picks a start mode: manual, scheduled, monitor, restock, or its own monitor. Delays, caps, hours, and the webhook save while the task is running. Store, SKU, account, proxy, and payment consent do not. The labels follow the snapshot language, English or Spanish.

The Stores screen edits the same per-store defaults as the desktop, in English or Spanish, including reset and preset import. The snapshot carries the saved store pages and the global numbers used for the source label. It does not carry card or proxy secrets.

The phone can turn Autopilot on or off and pause every running task. Those commands do not carry a card, password, or proxy password. The Mail screen can add a mailbox and switch the mail text between English and Spanish. Google and Microsoft sign-in opens the browser on the PC. An app password is sent once over the existing encrypted channel and is not echoed in the snapshot. The snapshot `imap` field lists mailbox status (no password, no refresh token) and whether desktop sign-in is configured.

The phone paints from the snapshot `brand` (name, theme, accent, success sound). It does not receive the desktop logo. Task rows can be swiped; the same actions stay on visible buttons. `mobile/plugins/withWidgets.js` adds an Android home widget during prebuild. Do not add an iOS WidgetKit target unless there is a checked-in Xcode project to test. The TestFlight path stays as it is.
