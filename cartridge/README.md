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
