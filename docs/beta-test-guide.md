# Zzz AIO v0.2.40-beta: manual test guide

This is a hands-on beta test of every module. Status meanings:

- **Ready**: automated tests pass against recorded or mocked store responses. It still needs your live test.
- **Partly**: the flow runs, but parts are generic or have known gaps.
- **Not ready**: don't rely on it yet.

No build has placed a real order on a live store from the build box. Your live runs are the real test.

**Start every store with Dry run on.** Only turn Dry run off for a real order once that store's dry run passes.

## Before you start (5 min)
1. Install `TCGAIO-Setup-0.2.43.exe` from the v0.2.43-beta release, or let the app auto-update. Sign in.
2. Go to **Settings → General → Dry run** and turn on **Dry run all**. Every task row now shows a yellow **DRY RUN** badge.
3. Add a profile (Profiles) and at least one proxy list (Proxies). Use the proxy **Test** button.
4. **Settings → Discord**: paste your webhook, switch on every event, and press **Test**. You should get one sample post per switched-on event.
5. Phone: install the phone APK from the release, then pair it in **Settings → Phone**.

## Dry run
- **What it does:**
  - The full flow runs for real: session, monitor, add to cart, shipping and payment.
  - Place order is **simulated and never sent**. An HTTP guard blocks the place-order request for every store, and a test runs every store module through that guard.
- **How to turn it on:**
  - Use the per-task "Dry run" checkbox in the task editor, or the global **Dry run all** switch.
  - A DRY RUN badge appears on each affected task row.
- **Success looks like this:**
  - The task ends as **tested**, with a status like `DRY RUN passed · 6 pass · 1 skip · place order simulated, not sent`.
  - The log has one line per step: `DRY RUN · PASS Cart (412 ms) — …`.
  - Where the store allows it, the test cart line is removed afterwards.
- **Dry run and alerts:**
  - It plays the **success** sound.
  - Discord posts it under the "Dry run results" switch with the title **DRY RUN · Store finished**.
  - Real success notices are never sent for a dry run.
- **Known issues:** some stores can't clear a cart line through their API, so you may see one item left in the cart. Remove it by hand.

## Per store

For every store, the steps are the same:
1. Accounts → add an account for the store → **Sign in** (a browser window opens). Sign in by hand and close the window when you see your account page. The session is captured.
2. Tasks → new task → store, SKU/URL, profile, account, proxy group. Leave Dry run on.
3. Press Start.

Success looks like the Dry run section above. If the step report shows a FAIL, it tells you which step failed and why.

| Store | Status | Notes / known issues |
|---|---|---|
| Target | Ready | Full API flow. A challenge pauses into the **Challenge needs you** handoff (see below). Resumes at the step it paused. |
| Walmart | Ready | A PerimeterX press-and-hold pauses into the handoff. Resumes by re-running the flow. Saved-card CVV may be asked. |
| Best Buy | Ready | Queue/"please wait" drops are watched. A verification code may be needed; set up IMAP. |
| Pokémon Center | Ready | Queue pages pause until you pass them. |
| Amazon | Ready | Uses its own robot check (no PerimeterX). A captcha or 2FA pauses. Paste a fresh session if asked. |
| Crunchyroll | Ready | |
| Bandai (p-bandai) | Ready | |
| TCGplayer | Ready | |
| GameStop | Partly | Generic page flow; no dedicated store tests yet. Run a dry run first and send me the log if a step fails. |
| Barnes & Noble | Partly | Generic page flow; no dedicated store tests yet. |
| Costco | Partly | Generic page flow; uses the form already on the store page. Membership sign-in needed. |
| Sam's Club | Partly | Generic page flow. |

**Every store:** a bot-check page pauses the task for a person. It never solves the check or tries to get around it. The integration test checks this for every store.

## Monitor → checkout linking
- **How to test:** create a monitor task for an in-stock SKU and link a checkout task to it (Linked checkout in the task editor). Start the monitor.
- **Success looks like this:**
  - The monitor shows **in stock**, the in-stock sound plays, and Discord posts an in-stock embed (image, name, store, price, SKU, link).
  - The linked checkout task starts on its own, in dry run.
- **Known issue:** if the store hides price or image, that embed field is left out.

## Warm-ups and Target keep-warm
- **Warm-ups:** Accounts → **Warm** on an account. It succeeds when the account shows a fresh "warmed" time.
- **Target keep-warm** (Settings → General → Advanced → "Keep Target warm between checkouts"):
  - What it does: it opens the cart in a hidden window at your interval, ±25% random spacing.
  - If a challenge shows up, it **stops for that account and alerts you**. It never tries to get past the challenge.
  - It skips accounts that are busy in a task.
- **Success looks like this:**
  - The logs show `Keep-warm: Target Main refreshed`.
  - When a challenge appears, the log shows `Keep-warm stopped for … challenge`, followed by the "Challenge needs you" alert.

## Target challenge handoff ("Challenge needs you")
- **Switch:** Settings → Discord → "Challenge needs you". It controls the phone alert, the desktop notification and the Discord ping. You can add an optional ping such as `@here`.
- **When a Target task hits a challenge, you get:**
  - a desktop notification. Click it and the challenge page opens already loaded, with the task's cookies.
  - a phone notification on the "Challenge" channel. Tap it and the challenge card opens the page.
  - a Discord post with a "What to do" line.
- **What you do:** clear the press-and-hold yourself.
- **Success looks like this:**
  - Zzz AIO only *reads* the page to see that the check is gone and the session cookie changed.
  - It then closes the window and resumes the task **from the step that paused**. For example, if checkout paused, the existing cart is reused and the monitor and add to cart are skipped.
- **Known issues:**
  - The phone alert comes over the live phone link (LAN or relay), not through Google push (FCM). The phone app must be open or running in the background.
  - The phone opens the page on the phone's own network, not through the task proxy.

## Sounds (PC and phone)
- **Where:** Settings → Discord → **Sounds**. There's a master on/off, a volume slider, and for each event an on/off switch, a sound picker and a **Preview** button.
- **Events and default sounds:**
  - In stock: Rise
  - Checkout success: Fanfare. Dry runs play this too.
  - Checkout failed/declined: Drop
- **Other sounds:** Chime, Bell, Pulse, Buzz and Knock are also available. The challenge alert has its own sound, which isn't in this list.
  - All sounds are generated by Zzz AIO (royalty-free).
- **Phone:**
  - The same choices sync to the phone.
  - Android makes one notification channel per event+sound (e.g. "In stock (rise)"). Change a channel's volume or vibration in Android settings.
- **Success looks like this:** Preview plays each sound on the PC. Running a dry run plays the success sound on the PC and in the phone notification.

## Discord
Each event has its own switch:
- In stock
- Back out of stock
- Checkout success
- Checkout failed/declined
- Dry run results (labeled DRY RUN)
- Proxy blocked
- Challenge needs you

How it behaves:
- **Test** sends one sample post for each event that's switched on.
- Posts go through a queue, and Discord rate limits (429) are retried after the wait Discord asks for.
- Card data is never sent.

## Settings tabs
- The top bar has four tabs:
  - **General**: account, Dry run all, monitor speed, updates, and Advanced (collapsed) with the extra tools.
  - **Phone**: pairing and relay.
  - **Discord**: webhook, event switches and Sounds.
  - **IMAP**: the mailbox for codes and order mail.
- **Deep links:** `#settings`, `#settings/phone`, `#settings/discord` and `#settings/imap`. The older `#settings/notifications` and `#settings/sounds` open Discord.

## Proxy rotation
- **Test:** add 2+ proxies, use **Test** in Proxies, then run two tasks.
- **Success looks like this:**
  - Tasks spread across the proxies.
  - A blocked proxy shows as banned for a while and gets rotated out. The "Proxy blocked" Discord event fires if it's switched on.
- **Status:** Ready.

## Phone sync
- **Test:** pair (Settings → Phone). Start or stop a task from the phone, and watch the status update on both sides.
- **Success looks like this:** changes show on the other side within about 2 seconds. Away from home (relay), it reconnects within a few seconds of reopening the app.
- **Status:** Ready.

## Admin app and site
- **Test:**
  - Install the Zzz AIO Admin APK and sign in. Staying signed in is new in 0.2.39.
  - Check licenses and users.
  - Open the admin site from Settings → General → "Open admin desk".
- **Status:** Ready. No server changes in this release.

## What to send me if something fails
The task log (Logs page → Copy) and the store name. A screenshot of the step report helps.
