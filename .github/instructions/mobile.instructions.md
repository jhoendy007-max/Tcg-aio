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

The phone can turn Autopilot on or off and pause every running task. Those commands do not carry a card, password, or proxy password.
