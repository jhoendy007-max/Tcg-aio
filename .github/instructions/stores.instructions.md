---
applyTo: "src/stores/**,src/engine/test-mode.ts,src/engine/task-runner.ts"
---

# Store modules

Each retailer is an HTTP module, not a browser checkout. `createXModule()` returns a `StoreModule`. `createRegistry()` in `src/stores/registry.ts` replaces the stub for that id.

`run(ctx)`:

- Require a real session cookie or access token before any cart call. Missing session returns `paused` and makes no HTTP call.
- A guest or logged-out member pauses before add-to-cart. Say that the user should sign in on the Session Keeper page. Do not describe that pause as a challenge. Challenge pauses use the existing phrases (`presented a challenge`, captcha, robot check) so the task runner can hand off to a person.
- Monitor with the store’s own public product API. Treat 429 and 5xx as retry: log, go back to monitoring, `ctx.sleep`. The runner already adds jitter and backoff.
- Stop on `ctx.signal`. Return `{ outcome: "stopped", reason: "Stopped" }`.
- In `ctx.testMode`, run through payment tokenization or the equivalent non-charging step, call `finishTest(ctx)`, and return. If `ctx.clearCartAfterTest` is set, remove only the line this run added.
- A confirmed run may place a ship-to-home order only after the user checked confirm. Premium Bandai does not: Global-e collects the card in the account browser, and the module pauses before `POST /api/checkout/{sn}/preComplete`. Do not invent a processor confirmation or send the card number, CVV, or PAN to Bandai.

`isFinalSubmit` in `src/engine/test-mode.ts` must match the place-order request exactly. The task runner replaces `ctx.http` with `guardTestMode` in test mode, outside the module, so a mistaken call still never hits the network.

Register the host in the challenge helper, Session Keeper home, health probe, keyword listing headers, bulk URL parser, and restock/Discord line parser. Refuse product URLs on any other host.

Do not port cookie banks, sensor cookies, TLS impersonation, captcha solvers, or account generation. Read a retailer page only to copy the requests the site’s own frontend already makes. Prefer a fixture trimmed from a real JSON response over a live call in tests.

Polite gaps live in `src/engine/polite.ts`. New stores use a gap of at least a few seconds. Health checks are one read-only GET.
