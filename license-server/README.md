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
| `TCGAIO_OWNER_SETUP_TOKEN` | Server, until the password is set | A long random string you choose. The first boot stores a hash of it. |
| `TCGAIO_OWNER_PASSWORD` | Server, first boot or `set-password` only | Password for `jhoendy007@gmail.com`, at least 8 characters. Remove it from the environment after it is saved. |
| `EXPO_ACCESS_TOKEN` | Server, optional | Expo access token. Without it, alerts are stored and push is skipped. |

Tables are created with `CREATE TABLE IF NOT EXISTS` the first time the server starts. You do not run a separate migration.

Login, claim, and admin login are limited to about 8 tries per 10 minutes per IP. The limit is in memory and resets when the process restarts.

## Owner account

`jhoendy007@gmail.com` is the only owner. The server creates that user and an owner license on first boot. Nobody else can register that email. The owner license works on up to 8 PCs and cannot be suspended or revoked. The role is inside the signed grant. Typing the email on a PC does not make someone the owner.

Keep `TCGAIO_OWNER_SETUP_TOKEN` the same until the password is saved. If you change it before that, password setup will fail.

## Push

Checkout alerts are off until you turn them on. Other alerts default to on: claimed, foreign PC, failed logins, expiring, revoked, suspended, and server errors.

The admin Android app registers an Expo push token. The server sends it to `https://exp.host/--/api/v2/push/send` when `EXPO_ACCESS_TOKEN` is set.

## Commands

```bash
npx tsx license-server/cli.ts keygen
npx tsx license-server/cli.ts serve
npx tsx license-server/cli.ts set-password
```

`npm run license:server` is the same as `serve`.

The admin page is `https://your-server/admin`. It is not inside the customer installer. The customer app only has Sign in and Create account.
