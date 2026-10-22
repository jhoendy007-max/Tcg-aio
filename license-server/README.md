# TCGAIO license server

One Node process and one SQLite file. Passwords are hashed with argon2id. Access grants are signed with Ed25519. The desktop app checks that signature with a public key baked in at build time, so a fake local server cannot unlock the app.

This stays a small program you run yourself. It does not need Cloudflare, Supabase, or a hosted database. Node already has SQLite, argon2id comes from `@noble/hashes`, and Ed25519 comes from `node:crypto`.

## What you need

- Node.js 22
- A VPS or a PC that stays on
- HTTPS in front of the process (Caddy or nginx). The desktop app calls this URL.

## Environment

| Name | Where | What it is |
| --- | --- | --- |
| `TCGAIO_LICENSE_PRIVATE_KEY` | Server only | PKCS8 Ed25519 private key, base64. From `keygen`. Never put this in the app or in GitHub. |
| `TCGAIO_LICENSE_PUBLIC_KEY` | Desktop build secret | The matching public key. GitHub Actions secret for the Windows build. |
| `TCGAIO_LICENSE_URL` | Desktop build secret | `https://your-server` with no path and no token. |
| `TCGAIO_LICENSE_DB` | Server | Path to the SQLite file, for example `/var/tcgaio/license.sqlite`. |
| `PORT` | Server | Defaults to `8787`. |
| `HOST` | Server | Address to bind. Defaults to `127.0.0.1`, which is what Caddy on the same machine should use. Set `HOST=0.0.0.0` only if you want the port open on every network interface. |
| `TRUST_PROXY` | Server | Set to `1` when the reverse proxy is not on this machine. See the rate-limit note below. |
| `TCGAIO_OWNER_SETUP_TOKEN` | Server, until the password is set | A long random string you choose. The first boot stores a hash of it. |
| `TCGAIO_OWNER_PASSWORD` | Server, first boot or `set-password` only | First password for `jhoendy007@gmail.com`, at least 8 characters. Remove it from the environment after it is saved. A later change uses `change-owner-password` or Change password on the admin desk. |
| `EXPO_ACCESS_TOKEN` | Server, optional | Expo access token. Without it, alerts are stored and push is skipped. |
| `TCGAIO_ADMIN_UPLOAD_TOKEN` | Server and GitHub Actions secret, same name | Long random string. Tag builds upload the admin APK with it. If the GitHub secret is missing, the build skips the upload and still succeeds. |
| `TCGAIO_ADMIN_APK_DIR` | Server, optional | Folder for the uploaded admin APK. Defaults to the folder that holds the SQLite file. |

Tables are created with `CREATE TABLE IF NOT EXISTS`. On startup the server also adds any missing account columns (`created_at`, `account_status`, `payment_method`, `paid`). Restart the process after updating the code. That keeps the existing owner row, password, and license. You do not run a separate migration.

Login, claim, and admin login are limited to about 8 tries per 10 minutes per client IP. The limit is in memory and resets when the process restarts. Caddy on this machine connects from `127.0.0.1` and sends `X-Forwarded-For`. The server uses the last address in that header, which is the visitor Caddy actually saw, so one person's failures do not lock everyone else. The same address is stored on failed-login rows. A connection that is not from loopback ignores `X-Forwarded-For` unless `TRUST_PROXY=1`.

## Owner account

`jhoendy007@gmail.com` is the only owner. The server creates that user and an owner license on first boot. Nobody else can register that email. The owner license works on up to 8 PCs and cannot be suspended or revoked. The role is inside the signed grant. Typing the email on a PC does not make someone the owner.

Keep `TCGAIO_OWNER_SETUP_TOKEN` the same until the password is saved. If you change it before that, password setup will fail.

`set-password` only saves the first password, and it still needs that setup token. After the password exists, replace a forgotten one on the server with `change-owner-password`. That command reads the new password from stdin, does not use the setup token, and signs out every existing owner session (the admin desk and the desktop app).

```bash
npx tsx license-server/cli.ts change-owner-password
```

Type the new password and press Enter. The characters stay hidden. From a pipe or a heredoc, the first line is the password:

```bash
npx tsx license-server/cli.ts change-owner-password <<'EOF'
the-new-password
EOF
```

`TCGAIO_LICENSE_DB` must point at the live SQLite file. The password needs at least 8 characters. Surrounding spaces are ignored, the same way sign-in ignores them. Do not put the password on the command line.

While you are signed in at `/admin` or in the admin app, Change password asks for the current password and the new one. A wrong current password stays on the desk. A successful change signs out the old sessions, then you sign in with the new password.

## Push

Checkout alerts are off until you turn them on. Other alerts default to on: new signup, claimed, foreign PC, failed logins, expiring, revoked, suspended, and server errors.

A customer can create an account with email and password and no license key. The account stays pending, and the desktop app shows a waiting screen that checks itself. The PC is bound on the first sign-in after a license is linked. Gift keys are still created on their own, then redeemed in the account. The owner can also generate a key and link it to a pending account in one step.

The admin Android app checks `GET /v1/admin/app` with the owner session and downloads `GET /v1/admin/app/download` when a newer versionCode is on the server. The APK is uploaded with `POST /v1/admin/app` and `Authorization: Bearer $TCGAIO_ADMIN_UPLOAD_TOKEN`. It is not attached to the public GitHub release.

The admin Android app registers an Expo push token. The server sends it to `https://exp.host/--/api/v2/push/send` when `EXPO_ACCESS_TOKEN` is set.

## Commands

`license-server/package.json` sets `"type": "module"`. The repo root stays CommonJS for the desktop app. That small file is what lets these commands use top-level await:

```bash
npx tsx license-server/cli.ts keygen
npx tsx license-server/cli.ts serve
npx tsx license-server/cli.ts set-password
npx tsx license-server/cli.ts change-owner-password
```

`set-password` reads `TCGAIO_OWNER_SETUP_TOKEN` and `TCGAIO_OWNER_PASSWORD` and refuses once a password is already saved. `change-owner-password` reads the replacement from stdin and signs out old sessions.

Behind Caddy, keep the default `HOST=127.0.0.1` and proxy to `127.0.0.1:8787`. Caddy's own connection is loopback, so the real visitor IP is taken from `X-Forwarded-For` without setting `TRUST_PROXY`.

`npm run license:server` is the same as `serve`.

The admin page is `https://your-server/admin`. It is not inside the customer installer. The customer app only has Sign in and Create account.
