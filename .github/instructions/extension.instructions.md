---
applyTo: "extension/**,scripts/pack-extension.mjs"
---

# Session Sync

Chrome and Edge Manifest V3 extension in `extension/`. It syncs the user's own signed-in store session to the desktop app. It is another paired device, named Session Sync, on the existing phone protocol (`PHONE_PROTOCOL` stays 1).

- Host permissions stay on the store sites in the catalog. Do not add `<all_urls>`, `tabs`, `webRequest`, or `history`.
- Read cookies only after the user links that account. `extension/policy.mjs` drops every other domain. localStorage is limited to `STORAGE_KEYS`.
- Pair with the one-time code from the desktop Phone page. The device token can be revoked there. Do not invent a second cipher.
- Two-way writes use `pairsFromHeader` and `STORE_ORIGINS`. Those are cookies the desktop already stored. Do not generate cookie names or values.
- Ignore cookie changes the extension itself just wrote, or a two-way push will loop.
- A browser push calls `updateSession` with `quiet` so the desktop does not send the same session straight back.
- The popup and the vault page never display the cookie. The phone snapshot never includes it.
- `npm run pack:extension` writes the unpacked zip and a `.crx` under `release/`. Do not commit a `.pem` or the CRX private key. Load unpacked is the supported install. Chrome will not sideload a packed `.crx` outside the Web Store or an enterprise policy.
