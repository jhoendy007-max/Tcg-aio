# Zzz AIO v0.2.46-beta: manual test guide

This is a hands-on beta test of every module. Status meanings:

- **Ready**: automated tests pass against recorded or mocked store responses. It still needs your live test.
- **Partly**: the flow runs, but parts are generic or have known gaps.
- **Not ready**: don't rely on it yet.

No build has placed a real order on a live store from the build box. Your live runs are the real test.

**Start every store with Dry run on.** Only turn Dry run off for a real order once that store's dry run passes.

## Before you start (5 min)
1. Install `TCGAIO-Setup-0.2.46.exe` from the v0.2.46-beta release, or let the app auto-update. Sign in.
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
- **Known issues:** Best Buy, Pokémon Center, Amazon and Crunchyroll cannot clear a cart line yet, so the test item stays in the cart. The log and the Dry run summary say so. Remove it by hand.

## Per store

For every store, the steps are the same:
1. Accounts → add an account for the store → **Sign in** (a browser window opens). Sign in by hand and close the window when you see your account page. The session is captured.
2. Tasks → new task → store, SKU/URL, profile, account, proxy group. Leave Dry run on.
3. Press Start.

Success looks like the Dry run section above. If the step report shows a FAIL, it tells you which step failed and why.

### Readiness table (0.2.46 audit)

Every row below was run end to end in Dry run against recorded or mocked store responses, and the test checks that the place-order request is never sent and that the per-step report is complete. "Needs live" is what no automated test can prove, because it needs your real account on the real store.

| Store | Status | Monitor | Login / session | Cart | Checkout dry run | Test item after a dry run | Needs live (your account) |
|---|---|---|---|---|---|---|---|
| Target | Ready | Product API: price, stock, image | Password or pasted session, plus Session-Sync / Save cookies | API add | Address, shipping, payment, then place simulated | **Removed** (cart line deleted) | Real sign-in, saved card, real challenge handoff |
| Walmart | Ready | Product page data: price, stock, seller, image | Account browser sign-in; Session-Sync / Save cookies | GraphQL add | Address, shipping, payment, then place simulated | **Removed**, or a clear warning if Walmart refuses | Real sign-in, saved card CVV, real PerimeterX hold |
| Best Buy | Ready | Product page and queue watching | Account browser sign-in; Session-Sync / Save cookies | API add | Shipping, payment, then place simulated | **Left in the cart** (warning in the log and the summary) | Real sign-in, emailed verification code (IMAP) |
| Pokémon Center | Ready | Product page, queue pages pause | Account browser sign-in; Session-Sync / Save cookies | API add | Shipping, payment, then place simulated | **Left in the cart** (warning) | Real queue, real sign-in |
| Amazon | Ready | Product page offers | Account browser sign-in; Session-Sync / Save cookies | Add form | Address, payment, then place simulated | **Left in the cart** (warning) | Real sign-in, 2FA, robot check |
| Crunchyroll | Ready | Store product page | Account browser sign-in; Session-Sync / Save cookies | API add | Checkout steps, then place simulated | **Left in the cart** (warning) | Real sign-in |
| Bandai (p-bandai) | Ready | Product page: stock and price | Account browser sign-in; Session-Sync / Save cookies | API add | Checkout steps, then place simulated | **Removed**, or a warning if the removal fails | Real sign-in, the payment page of Bandai's checkout partner |
| TCGplayer | Ready | Product page and listings | Account browser sign-in; Session-Sync / Save cookies | Forms on the page | Address, shipping, payment, then place simulated | **Removed** through the page's remove control; otherwise a warning | Real sign-in, saved payment |
| GameStop | Partly | Reads the page's price data (JSON-LD), purchase limit and "Currently Unavailable" text | Account browser sign-in; Session-Sync / Save cookies. Sign-in redirects are recognised | Forms on the page, quantity capped to the purchase limit | Same page flow, with the full report | **Removed** if the page shows a remove control; otherwise a warning | **Everything on the live site.** GameStop answers this build box with a Cloudflare check, so the page structure is unverified live. Any check pauses for you |
| Costco | Partly | Real product pages: price, item number, image, in/out of stock from the page. Warehouse inventory is not read (Costco serves it from a separate API that Zzz AIO does not use) | Account browser sign-in on Costco's own sign-in page; Session-Sync / Save cookies | Page forms if present, otherwise the status says you add the item in the account window | Same page flow; if the page has no cart form the step is marked **needs you** | As GameStop | Membership sign-in, the real cart and checkout |
| Sam's Club | Partly | Real product pages: price, ship-to-home stock, pickup-only detection, limit, image | Account browser sign-in; Session-Sync / Save cookies. The robot check page pauses for you | Page forms if present, otherwise **needs you** (Sam's builds the cart with scripts) | Same page flow | As GameStop | Membership sign-in, the real cart and checkout |
| Barnes & Noble | Partly | Real product pages: price, edition by ISBN, in/out of stock, image. An ISBN opens the right edition | Account browser sign-in (Shopify sign-in is recognised); Session-Sync / Save cookies | Page forms if present, otherwise **needs you** (checkout moved to Shopify) | Same page flow | As GameStop | Real sign-in, the real cart and Shopify checkout |

**What "needs you" means:** the monitor, price, stock and session part is done by Zzz AIO. The step that cannot be driven safely is shown in the task status in plain words (for example "Add the item and check out in the account window"), and the task pauses instead of failing.

**Cart cleanup:** turn on **Settings → After a passed test, remove the test line from the cart** (off by default). With Dry run and that setting on, Zzz AIO removes the test item wherever the store allows it (Target, Walmart, Bandai, and the page stores when a remove control is on the page). Where it cannot, or when the setting is off, the log shows a "Heads up" line and the Dry run summary ends with "test item left in the cart". Remove that item by hand before a real run.

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

## Proxies and account browsers (0.2.44)

- Every account browser (Sign in, session warm-up, keep-warm, the challenge window opened with "Open on PC") uses the same proxy its task uses. The account's own proxy group wins, otherwise the task's group. The account is pinned to one proxy and stays on it.
- The Accounts page shows "Browser proxy" for each account: bound to a proxy (host:port), binds on first use, direct, would run direct (its proxy group is empty or gone), or conflict (its tasks use different proxy groups).
- If a task has a proxy group but no proxy can be chosen, Zzz AIO will not open that browser direct. Warm-ups are skipped and Sign in asks first.
- Limit: the challenge page opened on the phone loads on the phone's own network, not through the task proxy. Use "Open on PC" for a proxied solve.
- Sign in window: a bar at the top shows the account email and a masked password with Copy buttons. The password is copied through the PC clipboard and cleared after 30 s if it is still there. Nothing is typed into the store page.

## Proxy rotation when a task fails (0.2.45)

- Settings → Advanced has **Rotate proxy on failure** (on by default) and **Max proxy rotations per run** (1–10, default 3). Each task can follow Settings, force On or Off, and set its own max in the task form (Advanced).
- A run rotates only for proxy reasons: connection refused, timeout, tunnel failure, proxy sign-in 407, an HTTP 403/429/412/435 block, or a store challenge that cannot be handed to a person. Card declined, out of stock, bad login and form errors never rotate.
- The failed proxy rests 5, then 10, 20 and 30 minutes on repeat failures. The next healthy proxy in the group is chosen in group order. The account's pin moves with it, so HTTP and later browser windows use the same proxy. The pin never moves otherwise.
- The task log shows `Proxy rotation 1/3: host:port (1 of 3) → host:port (2 of 3)`. Only host and port are shown, never credentials.
- Once a place-order request has gone out, Zzz AIO does not rotate or retry that checkout, so an order cannot be placed twice. Dry run still rotates, since nothing is ever placed.
- If the group has no healthy proxy left, the task stops with a message and sends the **Proxy blocked** Discord notice, even when that toggle is off, because a stopped task needs an alert.
- Limits: a sign-in window that is already open keeps its old proxy until you reopen it. Mid-run rotation after a 407 or repeated block needs at least 2 proxies in the group; a monitor with one proxy keeps its normal backoff. The phone app's task form does not carry the new fields yet (the PC settings apply).

## Eastern Time, cart warning and page stores (0.2.46)
- **Eastern Time:** Drops (start and stop), Analytics and the phone app now show **Eastern Time** (New York / Florida, follows daylight saving). Saved drop times are stored as exact moments, so nothing you saved changed or moved. Recurring drop-window text such as `09:00-17:00` (Settings and task hours) keeps its digits and now means Eastern wall-clock time. Until 1 November 2026 Eastern and the old Atlantic setting are the same clock; after that, Eastern is one hour behind Atlantic, so re-check any window you want to line up with a Puerto Rico hour.
- **Dry run cart warning:** every store now ends the dry run with a clear statement about the test item (removed, or left in the cart).
- **GameStop, Costco, Sam's Club, Barnes & Noble:** product pages are read from the store's own structured data (price, item number, image, limit, ship-to-home stock). Sam's Club no longer reports in stock because of an Add to cart button elsewhere on the page. The sign-in pages of Costco, Sam's Club and Barnes & Noble are recognised, so an expired session is flagged instead of saved as signed in.
- **Release signing:** the old public `tcgaio-release-keystore` build artifacts were deleted. Builds sign from the repository secrets, with the same certificate as before.
