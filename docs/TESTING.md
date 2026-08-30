# Testing

Three independent layers, chosen so the **write path is provable without a
deployed instance, without SLAS, and without a login** — then confirmed against a
real instance when one is available.

| Layer | What it proves | Needs an instance? | Needs SLAS/login? |
|---|---|---|---|
| **1. PWA component tests** (Jest) | The `NotifyMeForm` state machine (skeleton → guest / one-tap / already / done / error), the local-hint read on mount, and the idempotent submit — in **mock mode**. | No | No |
| **2. SFRA parity unit tests** (Mocha) | The **real custom-object write logic** — dedupe, server-derived email, status codes — driven directly through the controller handler with the `server` framework and every `dw/*` class stubbed. | No | No |
| **3. Manual live test** (curl / browser) | The same write logic executing **on a real instance**, end-to-end through login + CSRF + `CustomObjectMgr`. | Yes | Session cookie only (no SLAS) |

The point of layer 2 is the take-home's central architectural claim: **SLAS is a
transport-layer concern, not a business-logic dependency.** The SCAPI endpoint
(`rest-apis/waitlist`) and the SFRA controller (`controllers/WaitList.js`) run the
*same* dedupe-and-write logic; the only difference is how the caller's identity
arrives (SLAS bearer token vs. storefront session). The SFRA route lets us exercise
that logic with zero SLAS setup.

---

## Layer 1 — PWA component tests (Jest)

```bash
# from the retail-react-app project root (overrides copied in)
npm test -- notify-me
```

8 tests, all green. Covers: OOS PDP renders Notify Me; guest sees the sign-in
prompt (no email field); registered shopper sees one-tap; the **already-subscribed
hint is read locally on mount with NO network call**; a successful submit writes the
hint and shows the passive confirmation; a failed live submit surfaces an accessible
error with a single POST (no pre-check GET). Mock mode is the default
(`WAITLIST_LIVE !== 'true'`) — only the network POST is faked; the local-hint logic
and the UI state machine run identically in both modes.

---

## Layer 2 — SFRA parity unit tests (Mocha) — no instance, no SLAS

```bash
cd app_waitlist
npm install        # mocha, chai, sinon, proxyquire (dev only)
npm test
```

```
  WaitList controller (SFRA parity route)
    route wiring
      ✔ gates Subscribe behind HTTPS + login + CSRF
      ✔ gates Status behind HTTPS + login
    Subscribe (POST)
      ✔ creates a PENDING subscription for a new (email, sku) and returns subscribed
      ✔ is idempotent: an existing row returns already-subscribed and writes nothing
      ✔ NEVER trusts an email from the request — uses the session profile (LOCKED #2)
      ✔ rejects a missing sku with 400
      ✔ rejects a session with no account email with 401
    Status (GET)
      ✔ reports subscribed:true when a row exists
      ✔ reports subscribed:false when no row exists
      ✔ rejects a missing sku with 400
      ✔ fails open (subscribed:false) if the session has no email

  11 passing
```

**How it works** (`test/unit/controllers/waitList.test.js`): `proxyquire` loads
`WaitList.js` with the SFRA `server` module replaced by a minimal mock
(`test/mocks/server.js`) that captures each route's full middleware chain. The test
pulls the registered handler by name and calls it with a fake `(req, res, next)`.
`dw/object/CustomObjectMgr`, `dw/system/Transaction`, and `dw/util/Calendar` are
sinon stubs, so no platform runtime is needed. The security assertion is explicit:
even when the request body carries `email: attacker@evil.com`, the object is keyed and
stored with the **session profile** email.

---

## Layer 3 — Manual live test (curl / browser) — real instance, no SLAS

Exercises the identical write logic on a deployed sandbox with only a **logged-in
storefront session**. No SLAS client, no bearer token.

**Prerequisites:** `app_waitlist` on the site cartridge path, code version active,
`WaitlistSubscription` custom object type imported, and a registered storefront
account you can log in as.

### Option A — browser DevTools (simplest)
1. Log in to the storefront as a registered shopper.
2. Open DevTools → Console and run (the CSRF token is minted server-side per session;
   fetch it from the login/account form, or from a rendered `dwfrm_*_csrf_token` field):

   ```js
   await fetch('/on/demandware.store/Sites-RefArch-Site/en_US/WaitList-Subscribe', {
     method: 'POST',
     headers: {'Content-Type': 'application/x-www-form-urlencoded'},
     body: new URLSearchParams({sku: 'YOUR-VARIANT-SKU', csrf_token: CSRF})
   }).then(r => r.json())
   // → {success: true, status: "subscribed"}   (run again → "already-subscribed")
   ```
3. Verify in Business Manager → Custom Object Editor → `WaitlistSubscription`: one
   `PENDING` row keyed on `sha256(sessionEmail|sku)`, `email` = the **account** email
   (never anything from the request), `productID` = the variant SKU.

### Option B — curl (scriptable)
```bash
# 1. Log in and keep the session cookie jar.
curl -c jar.txt -s -o /dev/null \
  'https://<host>/on/demandware.store/Sites-RefArch-Site/en_US/Login-Show'
# (submit Account-Login with your credentials + its csrf_token to populate jar.txt)

# 2. POST the subscription with the session cookie + a valid csrf_token.
curl -b jar.txt -s \
  'https://<host>/on/demandware.store/Sites-RefArch-Site/en_US/WaitList-Subscribe' \
  --data-urlencode 'sku=YOUR-VARIANT-SKU' \
  --data-urlencode "csrf_token=$CSRF"
# → {"success":true,"status":"subscribed"}
```

**What this confirms that layer 2 can't:** the login gate (`userLoggedIn`) and CSRF
middleware actually reject anonymous / forged requests on the platform, and
`CustomObjectMgr` persists a real row. **What it still doesn't need:** any SLAS client,
OAuth flow, or PWA build — proving the business logic is independent of the SLAS
transport. Anonymous or CSRF-less requests are rejected by the middleware before the
handler runs.

> Security note: never paste real account passwords into shared logs. Use a throwaway
> sandbox account; the `csrf_token` and session cookie are short-lived per session.
