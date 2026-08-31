# The Back-In-Stock Waitlist Engine

An SFCC B2C Commerce feature: on an **out-of-stock PDP**, the storefront swaps
*Add to Cart* for a *Notify Me* form. Signups are persisted, and a scheduled job
periodically checks **variant-level** inventory and, on replenishment, calls an
**external REST API** (mock email) — resiliently, and safe to re-run.

> Built for the Adyen Senior SWE (SFCC) take-home. There is **no native SFCC
> back-in-stock feature and no PWA-Kit reference implementation** (verified
> against the `pwa-kit` source), so this is built from platform primitives. The
> interesting engineering is the four named resilience problems — high-concurrency
> signups, partial replenishment, external rate-limits/timeouts, and variant-level
> SKU resolution — not the happy path.

---

## Architecture

```
Shopper (PWA Kit PDP, React)  — REGISTERED USERS ONLY
  variant.orderable === false  ->  render <NotifyMeForm sku=selectedVariantId>
        guest  -> "Sign in to be notified" prompt (opens AuthModal)
        registered -> read LOCAL hint on mount (localStorage, NO network):
                        hint set     -> passive "already on the list" (no button)
                        no hint      -> one-tap "Notify me" (no email field)
        │  POST {sku, locale}  (SLAS registered token; NO email in body)
        │  (on success -> write localStorage hint so a refresh shows "already")
        ▼
Custom SCAPI endpoint  /custom/waitlist/v1/organizations/{orgId}/subscriptions
  POST          reject guest token (401) -> email = session customer profile email
                -> query-before-insert dedupe -> Transaction.wrap(createCustomObject)
                -> 200 {status: subscribed | already-subscribed}  (idempotent)
  GET  ?sku=..  fail-open -> {subscribed:bool}   (getWaitlistStatus)
                account "my waitlist" view ONLY — NOT called by the PDP (kept off
                the critical path; the idempotent POST makes re-clicks harmless)
        ▼
Custom Object  WaitlistSubscription  (key = sha256(email|sku))
  email(server-derived), productID(VARIANT SKU),
  status[PENDING|NOTIFIED|FAILED], locale, createdAt, notifiedAt, attemptCount
        ▼
Scheduled chunk Job  custom.WaitlistNotifyStep  (hybrid: import-chained + recurring reconcile)
  read  -> PENDING rows, sorted productID asc, createdAt asc
  process -> skuCache dedup: one ProductMgr availabilityModel.isInStock(threshold) per SKU
  write -> service.call(); branch on Result; commit status per row (Transaction.wrap)
        ▼
Outbound Service  waitlist.http.notify  (timeout + circuit breaker + rate limit)
  POST -> https://webhook.site/<uuid>   (mock email sink)
```

---

## Repository layout

```
app_waitlist/                         # the cartridge (add to the site cartridge path)
  cartridge/
    rest-apis/waitlist/               # Custom SCAPI endpoint
      schema.yaml  api.json  script.js  (exports.joinWaitlist + getWaitlistStatus)
    scripts/
      steps/notifyWaitlist.js         # chunk job (beforeStep/read/process/write/afterStep)
      services/waitlistNotifyService.js
      util/waitlistKey.js             # sha256(email|sku)
    controllers/WaitList.js           # SFRA-parity route (optional)
  steptypes.json                      # registers custom.WaitlistNotifyStep
  package.json

metadata/back_in_stock/               # importable site-import archive (XML deliverable)
  meta/custom-objecttype-definitions.xml   # WaitlistSubscription
  services.xml                        # service + profile + credential (reference)
  jobs.xml                            # recurring job schedule

pwa/overrides/app/components/         # synced MIRROR of the runnable storefront overrides/
  notify-me/index.jsx                 # registered-only Notify Me (skeleton|guest|one-tap)
  product-view/index.jsx              # PDP buy-box override: ATC <-> NotifyMeForm

SEED_DATA.md                          # Route A: get a few products + an OOS one
README.md                            # this file
```

---

## Setup

### 1. Data (see `SEED_DATA.md`)
Import RefArch/RefArchGlobal demo data so a site + catalog + inventory exist, then set
one variant's inventory to 0.

### 2. Deploy the cartridge
- WebDAV-upload `app_waitlist` (VS Code **Prophet** / `dwupload` / `sgmf-scripts`; a
  BM-generated **access key** is the WebDAV password for SSO accounts).
- Add `app_waitlist` to the **site cartridge path** (Merchant Tools → site → Settings)
  **and** the Business Manager cartridge path — the SCAPI endpoint 404s until the
  cartridge is on the path.
- **Activate the code version** — this is what registers the custom SCAPI endpoint.

### 3. Import metadata
Administration → Site Development → **Site Import & Export** → upload a zip of
`metadata/back_in_stock/` → Import. This creates the `WaitlistSubscription` custom object
type (and, if the services/jobs XML imports cleanly, the service + job — otherwise create
those two in the BM UI; see below).

### 4. Configure the outbound service
Administration → Operations → **Services**:
- **Credential** `waitlist.http.notify.cred` → URL = your `https://webhook.site/<uuid>`.
- **Profile** `waitlist.http.notify.profile` → timeout 5000ms; circuit breaker 5/30000ms;
  rate limit 50/60000ms.
- **Service** `waitlist.http.notify` → type HTTP, enabled. (Set **mock mode = true** to run
  the whole flow with no real endpoint — `mockCall` returns 200.)

### 5. Schedule the job (hybrid trigger)
Administration → Operations → **Jobs** → new job → add step `custom.WaitlistNotifyStep`,
scope your site, `NotifyThreshold=1`, schedule recurring (**every 5 min** — the run is cheap:
one inventory check per distinct waiting SKU, then exit). Exit rules: `ERROR` → stop;
`FINISHED_WITH_WARNINGS` → continue. This is the **reconciliation** half of the hybrid trigger.
For near-real-time notification, register the **same** `custom.WaitlistNotifyStep` as a step
immediately **after** your inventory-import job step (the **event-primary** half) — both paths
run identical step code.

### 6. Run PWA Kit
In the `retail-react-app` template, set `config/default.js` with your `shortCode`,
`organizationId` (`f_ecom_zzft_025`), `siteId`, and SLAS `clientId`; copy the two files
from `pwa/overrides/` into the matching override paths; `npm start` → `localhost:3000`.

**Two non-obvious requirements for the custom SCAPI endpoint to work from PWA:**
1. **Custom-API paths are RELATIVE to `/organizations/{organizationId}`** — the platform
   auto-prepends that segment. `schema.yaml` therefore uses `paths: /subscriptions:` and
   does **not** declare an `organizationId` path parameter. Declaring the full
   `/organizations/{organizationId}/subscriptions` path doubles the org segment and makes
   *every* request untranslatable (client sees HTTP 404, instance log shows
   "Custom API request couldn't be translated"). This is a correctness requirement, not
   test plumbing — the endpoint 404s for any caller if the path is absolute.
2. **The SLAS client must be granted the endpoint's required scope** (`c_waitlist_rw`, from
   the schema's `security: ShopperToken: [c_waitlist_rw]`). Add it to the client via SLAS
   Admin (`PUT .../shopper/auth-admin/v1/tenants/{tenant}/clients/{clientId}`, `scopes` as a
   JSON array). Without the scope the endpoint returns **403** "Request path is not allowed,
   because of missing or invalid permissions" (distinct from the 404 above).

**Verified live end-to-end on WaitlistDemo (SLAS tokens, curl):**
- Guest token → `GET getWaitlistStatus` → `200 {"subscribed":false}`; `POST joinWaitlist`
  → `401 guest-not-allowed` (registered-only gate, proper SCAPI custom error).
- Registered token (PKCE login) → `GET` → `200 subscribed:false` → `POST` →
  `200 {status:"subscribed"}` → re-`POST` → `200 {status:"already-subscribed"}` (idempotent)
  → `GET` → `200 subscribed:true`.

---

## Install on an SFRA site (step by step)

This is the SFRA-specific path (server-rendered storefront). The
`rest-apis/waitlist/` folder is only for the PWA-Kit build — SFRA uses the
`WaitList.js` controller instead, so you can ignore that directory here.

Everything below is standard SFCC wiring. **The only customer-specific value is
the outbound service URL in step 4** — nothing is hardcoded to a particular
instance.

### 1. Deploy the cartridge to the active code version
- WebDAV-upload the `app_waitlist` folder into the active code version (VS Code
  **Prophet**, `dwupload`, or `sgmf-scripts`). For an SSO account, the WebDAV
  password is a **BM-generated access key**, not your login password.
- **Activate (or re-activate) the code version.** This is the step that registers
  `custom.WaitlistNotifyStep` from `steptypes.json` — a plain WebDAV copy into the
  already-active version does *not* register it (you would get `StepTypeIdUnknown`
  when the job runs).

### 2. Add it to the site cartridge path — **before `app_storefront_base`**
Merchant Tools → *(site)* → Settings → Manage the Storefront Cartridge Path:
```
app_waitlist:app_storefront_base
```
Order matters. `app_waitlist` ships a full override of
`product/productDetails.isml` (the "Notify Me" swap + live variant reactivity). If
`app_waitlist` is not *ahead* of `app_storefront_base`, the override never wins and
the button will not appear. Add it to the **Business Manager** cartridge path too if
you want the BM-side scripts on the path.

### 3. Import the metadata (creates the custom object type)
Administration → Site Development → **Site Import & Export** → upload a zip of
`metadata/back_in_stock/` → Import. The must-have piece is the
**`WaitlistSubscription`** custom object type (`custom-objecttype-definitions.xml`) —
this is where signups are stored (storage scope = **site**).

> `services.xml` / `jobs.xml` in the same folder are version-sensitive imports. If
> they import cleanly, great; otherwise create the service and job in the BM UI
> (steps 4–5) — the custom-object import is the one that always works.

### 4. Configure the outbound notify service (the one customer-specific step)
Administration → Operations → **Services**:
- **Credential** `waitlist.http.notify.cred` → set the **URL to your own email /
  notification endpoint** (an ESP webhook, a middleware endpoint, etc. — the repo
  ships a `webhook.site` sink as a stand-in).
- **Profile** `waitlist.http.notify.profile` → timeout 5000 ms, circuit breaker
  5/30 s, rate limit 50/60 s (tune to your provider).
- **Service** `waitlist.http.notify` → type HTTP, enabled. Set **mock mode = true**
  to exercise the whole flow with no real endpoint (`mockCall` returns 200).

### 5. Schedule the notify job (reconciliation half)
Administration → Operations → **Jobs** → new job → add step
`custom.WaitlistNotifyStep` → scope it to **your site**, `NotifyThreshold=1`,
recurring (e.g. every 5 min — the run is cheap: one inventory check per distinct
waiting SKU, then exit). Exit rules: `ERROR` → stop.

### 6. (Recommended) Near-real-time notifications — chain the same step after your stock feed
The step is **self-contained**: its `beforeStep` opens its own query for `PENDING`
rows and it takes **no input from any prior step** — it only needs to run in the
site context. So you can add the *same* `custom.WaitlistNotifyStep` as a **second
step in the job that already imports your inventory feed**, right after the import
step. Steps in a flow run sequentially and each commits before the next starts, so
by the time the notify step reads inventory the restock is already live.

In `jobs.xml` this is just a second `<step>` in the same `<flow>`:
```xml
<job job-id="InventoryImportAndNotify">
    <flow>
        <context site-id="YOUR-SITE-ID"/>
        <!-- Step 1: your existing stock feed import (placeholder) -->
        <step step-id="import" type="ImportInventoryLists" enforce-restart="false">
            <parameters>
                <parameter name="ImportFile">inventory/stock.xml</parameter>
                <parameter name="ImportMode">MERGE</parameter>
            </parameters>
        </step>
        <!-- Step 2: SAME notify step, now event-primary -->
        <step step-id="notify" type="custom.WaitlistNotifyStep" enforce-restart="false">
            <parameters>
                <parameter name="NotifyThreshold">1</parameter>
            </parameters>
        </step>
    </flow>
    <rules>
        <on-exit status="ERROR"><stop-job/></on-exit>
    </rules>
</job>
```
Or in the BM Jobs UI: open your inventory-import job → **Job Steps** → add
`custom.WaitlistNotifyStep` after the import step, same site scope,
`NotifyThreshold=1`.

**Keep the recurring job from step 5 as well** — running both is harmless (the step
reads only `PENDING` rows and flips them per row, so whichever runs first notifies
and the other finds nothing). Event-primary gives latency; the recurring job is the
reconciliation safety net that catches manual BM stock edits, feed-mapping gaps, and
rows left `PENDING` by a transient failure. Two things to get right:
1. **Exit rules** — make sure a non-fatal `FINISHED_WITH_WARNINGS` from the import
   step does not abort the flow before the notify step runs.
2. **Commit boundary** — steps are sequential and each commits before the next, so
   the notify step always reads committed inventory (no partial-read race).

### What the shopper sees (no extra work)
Once the above is done, on any PDP where the selected variant is out of stock the
template automatically hides Add-to-Cart and shows **"Notify me when back in
stock"** (registered-users-only; guests are routed to Login), flips live as the
shopper changes size/color, and POSTs to the already-registered `WaitList-Subscribe`
route. If you already override `product/productDetails.isml`, merge the ~30-line
waitlist block (after `prices-add-to-cart-actions`) plus the inline `<script>` into
your override.

**Guest → login → auto-subscribed (no re-click, no added latency).** A guest who
clicks "Notify Me" is sent to `WaitList-BeforeLogin?sku=…`, which stashes two
things in the session: the originating PDP URL (`waitlistReturnUrl`) and the
subscribe **intent** (`waitlistPendingSku`). It then hands off to the standard
login. On a successful login **or** registration, `Account.js` (an extension of
the base Account controller via `server.extend(module.superModule)`) runs a
`route:BeforeComplete` hook that reads the pending SKU and writes the subscription
**server-side, inside the same login request**, using the now-authenticated email
(`res.viewData.authenticatedCustomer.profile.email`). The shopper then lands back
on the PDP (via the `accountHelpers.getLoginRedirectURL` `module.superModule`
override that prefers `waitlistReturnUrl`) with a `?wlnotified=1` marker, and the
button shows "On the waitlist ✓" with **zero extra network calls**. Net effect:
the guest clicks once, logs in, and is already on the waitlist — they never click
"Notify Me" a second time.

Design notes:
- **No extra round-trip.** The write happens during the login POST, not as a
  follow-up ajax call, so there is no perceptible latency.
- **Shared write path.** The controller click (`WaitList-Subscribe`) and the
  post-login hook both call `scripts/helpers/waitlistSubscribe.js`, so dedupe, the
  `sha256(email|sku)` key, and the status machine are identical either way.
- **Open-redirect safe.** The return URL is built server-side from the SKU
  (`URLUtils.url('Product-Show', …)`), never from client input.
- **Fail-safe.** If the write throws it is logged and swallowed — a waitlist
  problem never breaks the login. On a *failed* login the pending intent is left
  in place so the next successful attempt still completes it.
- **No-op for everyone else.** Normal logins (no stashed intent) fall through to
  base behavior unchanged — verified: they still land on `Account-Show`.

---

## Resilience (the design centerpiece)

| Requirement | Failure mode | Design response |
|---|---|---|
| **High-concurrency signups** | Double-click / two requests create dup rows for same email+SKU | Deterministic **key** `sha256(email\|sku)` (email is server-derived, so the key is stable per shopper) + **query-before-insert inside `Transaction.wrap`**. The query is the real guard; the key is defense-in-depth (duplicate-key create behavior is undocumented). |
| **Partial replenishment** | 100 waiting, 8 units restocked | **NotifyThreshold** + `isInStock(threshold)`; process **oldest-first** (`custom.productID asc, custom.createdAt asc`) for fair FIFO within each SKU; only flip rows actually notified. |
| **External rate limits** | Endpoint throttles a burst | Services **rate limiter** → `Result` unavailable-reason `RATE_LIMITED`; row **stays PENDING**, retried next run. |
| **Timeouts** | Slow/hung endpoint | Profile `timeout` → `TIMEOUT`; circuit breaker opens after N failures → `CIRCUIT_BROKEN` short-circuits the rest of the run cheaply. Row stays PENDING. |
| **Variant-level SKU** | Master has no sellable inventory | **Store the variant SKU** (decided at signup: PDP sends `selectedVariantId`); resolve via `ProductMgr.getProduct(sku).getAvailabilityModel()`. |
| **Re-run safety** | Job retried after a crash | Status machine `PENDING → NOTIFIED`; job reads only `PENDING`; per-row commit. A `NOTIFIED` row is never re-read → at-least-once (documented). |
| **Orphaned SKUs** | Product deleted/offline after signup | `getProduct` null-check → skip; age out to `FAILED` after `MAX_ATTEMPTS`. |
| **PII in logs** | Emails leaking to platform logs | `filterLogMessage` regex-scrubs emails. |

Why the Services framework: timeout, circuit breaker, and rate limiter are all
BM-configured on the **Service Profile** and surface uniformly through the `Result` object,
so `service.call()` never throws — the job inspects `result.isOk()` /
`result.getUnavailableReason()` and decides whether to keep the row PENDING (transient) or
mark it FAILED (hard error).

---

## Testing

Three layers, designed so the **write path is provable with no instance, no SLAS,
and no login** — see `docs/TESTING.md` for the full recipe.

- **PWA component tests** (Jest) — the `NotifyMeForm` state machine + local-hint,
  in mock mode. `npm test -- notify-me` (8 green).
- **SFRA parity unit tests** (Mocha) — the **real custom-object write logic** (dedupe,
  server-derived email, status codes) driven through the controller with `server` and
  every `dw/*` class stubbed via proxyquire. `cd app_waitlist && npm install && npm test`
  (11 green). Proves SLAS is a transport concern, not a business-logic dependency.
- **Manual live test** (curl / browser) — the same logic on a real sandbox through
  login + CSRF + `CustomObjectMgr`, using only a session cookie (no SLAS token).

---

## Honest limitations

- **At-least-once, not exactly-once.** A crash between a successful service call and the
  status commit re-notifies exactly one row on the next run. Acceptable for email; noted.
- **Duplicate-key `createCustomObject` behavior is undocumented** → mitigated by the explicit
  query-before-insert.
- **`services.xml` / `jobs.xml` import schemas are version-sensitive.** If they don't import
  cleanly, create the service and job in the BM UI (values above) and export to regenerate
  authoritative XML for the instance. The **custom-object** XML is the reliable import.
- **Data growth**: custom objects cap at ~400k/instance. A production build adds a TTL
  cleanup step removing old `NOTIFIED` rows.
- **Availability freshness**: inventory is read at job time; between runs a restocked SKU can
  resell out — the `NotifyThreshold` mitigates the 1-unit-thundering-herd case.

---

## Demo video outline (3–5 min)
1. Problem + "no prior art, built from primitives."
2. Shopper flow (registered-only): OOS PDP as a **guest** → "Sign in to be notified" prompt →
   sign in → **one-tap Notify Me** (no email field) → success; switch to in-stock variant → ATC
   restores (proves variant-level detection).
3. BM Custom Object list: the new `PENDING` row with the variant SKU and the shopper's
   server-derived email.
4. Restock the SKU in BM Inventory → run the job → webhook.site receives the POST → row
   flips to `NOTIFIED`.
5. Resilience: point at the Service Profile (timeout/CB/rate-limit) + the status machine —
   "transient failure stays PENDING and retries; NOTIFIED never re-fires."
