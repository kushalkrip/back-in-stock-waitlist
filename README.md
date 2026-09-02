# The Back-In-Stock Waitlist Engine

An SFCC B2C Commerce feature: on an **out-of-stock PDP**, the storefront swaps
*Add to Cart* for a *Notify Me* signup. Signups persist to a custom object, and a
scheduled job periodically checks **variant-level** inventory and, on replenishment,
calls an **external REST API** (a mock email sink) — resiliently, and safe to re-run.

> Built for the Adyen Senior SWE (SFCC) take-home. There is **no native SFCC
> back-in-stock feature and no PWA-Kit reference implementation**, so this is built
> from platform primitives. The interesting engineering is the four named resilience
> problems — high-concurrency signups, partial replenishment, external
> rate-limits/timeouts, and variant-level SKU resolution — not the happy path.

## Key design decision: registered users only

Signup is **registered-users-only**. The subscriber email is derived **server-side**
from the authenticated shopper's profile and is never accepted from the client:

- **Guest** on an OOS PDP → a "Sign in to be notified" prompt (opens the AuthModal).
- **Registered** shopper → a **one-tap "Notify me"** button (no email field at all).

This removes a whole class of abuse/validation problems (typo'd or spoofed addresses,
notifying someone who didn't ask) and keeps the payload to `{sku, locale}`. Rationale
and the two other locked decisions (hybrid inventory trigger; single SKU-indexed custom
object with a step-scoped availability cache) are in [`docs/HLD.md`](docs/HLD.md).

## Repository layout

```
├── docs/                 # Technical deliverables
│   ├── HLD.md            #   High-level design + the three locked decisions
│   ├── UI-DESIGN.md      #   PDP component design (identity branches, a11y, telemetry)
│   └── DELIVERY-PLAN.md  #   Build/verification plan
│
├── cartridge/            # SFCC BACKEND deliverable (the metadata XML + server code)
│   ├── app_waitlist/     #   Custom SCAPI endpoint, chunk job, service, SFRA parity controller
│   ├── metadata/         #   Importable site-import archive (custom object, service, job XML)
│   ├── pwa/              #   Synced mirror of the frontend overrides (for a self-contained cartridge)
│   ├── README.md         #   Backend architecture, setup, resilience table, honest limitations
│   └── SEED_DATA.md      #   How to load demo data + create an OOS variant
│
└── storefront/           # RUNNABLE PWA Kit app (retail-react-app template-extend)
    ├── overrides/        #   notify-me/ (the Notify Me component) + product-view/ (buy-box swap)
    ├── config/           #   SCAPI connection params (shortCode / org / site / SLAS client)
    └── package.json      #   `npm start` -> localhost:3000
```

## Running the two halves

**Storefront (frontend):** `cd storefront && npm ci && npm start` → http://localhost:3000.
It defaults to **MOCK_MODE** (submit simulates a successful call) so it runs offline / without
a sandbox. Set **`WAITLIST_LIVE=true`** to hit the real deployed `custom/waitlist/v1` endpoint
on `zzft-025` through the PWA Kit proxy with a SLAS shopper token — this live path is proven
end-to-end (see [`cartridge/README.md`](cartridge/README.md) and `docs/HLD.md §12`).

**Cartridge (backend):** deploy `cartridge/app_waitlist` to the sandbox and import
`cartridge/metadata/back_in_stock/`. Full steps in [`cartridge/README.md`](cartridge/README.md).

**Installing on your own SFRA site:** a step-by-step SFRA install guide — deploy +
activate, cartridge path ordering, metadata import, the outbound service, the notify
job, and how to chain it after your inventory feed for near-real-time notifications —
is in [`cartridge/README.md` → *Install on an SFRA site*](cartridge/README.md#install-on-an-sfra-site-step-by-step).

## Testing

Three layers, one per concern. Each app owns its own runner:

- **Jest** (storefront) — **19 tests** across two component suites. `notify-me`
  covers the identity branches (skeleton / guest / registered one-tap / already /
  done / error) and the submit path in mock + live mode; `product-view` covers the
  buy-box wrapper — passthrough when in stock / loading / set / bundle / unresolved
  variant, and the swap (drop `addToCart`/`updateCart`, inject `NotifyMeForm` via
  `customButtons`) for a resolved OOS variant, the master-level fallback when every
  variant is unorderable, plus the `?forceOOS=1` preview.
  `product-view` is at 100% line/branch coverage.
  ```bash
  cd storefront && npm test
  ```

- **Playwright** (storefront) — E2E specs that drive the *running* PWA in a real
  browser: the OOS buy-box swap (Add to Cart → Notify Me) via the `?forceOOS=1`
  demo helper, the guest "sign in to be notified" branch, and the AuthModal handoff.
  They run as a **guest** — the registered submit path needs a real login and is
  covered by Jest instead.
  ```bash
  cd storefront
  npx playwright install chromium   # first run only: fetch the browser binary
  npx playwright test               # runs all specs
  ```
  You don't need to start the app yourself: the `webServer` block in
  `playwright.config.js` reuses a dev server already on `:3000`, or runs `npm start`
  for you if none is up. `WAITLIST_LIVE` is irrelevant here (guest flow, no submit).
  Handy variants:
  ```bash
  npx playwright test --headed              # watch it in a real browser window
  npx playwright test --ui                  # interactive step-through debugger
  npx playwright test -g "auth modal"       # a single test by name
  npx playwright show-report                # open the last HTML report
  ```

- **Mocha** (cartridge) — **95 tests** covering every server-side module. The
  `dw/*` platform classes and `*/cartridge/...` requires are stubbed with
  `sinon` + `proxyquire` (`superModule` overrides are injected via a custom
  `Module._compile`), so the job lifecycle, the SCAPI handlers and the SFRA hooks
  all run under plain Node:
  ```bash
  cd cartridge/app_waitlist && npm test
  ```

  | Area | File under test | What it locks down |
  |---|---|---|
  | Idempotency key | `scripts/util/waitlistKey.js` | SHA-256 of `lower(trim(email))\|sku`; case/whitespace collision; sku case-sensitivity; null-safety |
  | Subscribe helper | `scripts/helpers/waitlistSubscribe.js` | new→`subscribed` row shape, existing→`already-subscribed` (no insert), `no-account-email`/`invalid-sku` guards |
  | **Notify job** (chunk step) | `scripts/steps/notifyWaitlist.js` | PENDING-only sorted query; variant-level `isInStock(threshold)`; per-SKU availability cache (O(distinct SKUs)); transient→stay PENDING+warning vs hard→FAILED at cap vs orphan expiry |
  | **SCAPI endpoint** | `rest-apis/waitlist/script.js` | `joinWaitlist` (subscribed / already / **body-email ignored** / guest 401 / no-email 401 / invalid-json 400 / invalid-sku 400 / persistence 500) + `getWaitlistStatus` (true / false / 400 / guest fail-open) |
  | Outbound service | `scripts/services/waitlistNotifyService.js` | request shaping, status parsing, mock 200, **PII log scrubbing** |
  | Post-login resume | `controllers/Account.js` | subscribe on auth success, `?wlnotified=1`/`&` marker, no-op / leave-pending / swallow-error branches on both Login + SubmitRegistration |
  | Login redirect | `scripts/helpers/accountHelpers.js` | one-shot stashed return URL vs delegate-to-base |
  | Demo seeder | `scripts/steps/seedInventory.js` | allocation writes, distinct PENDING derivation, SeedLimit cap, NO_LIST guard |
  | Demand report | `scripts/helpers/waitlistDemand.js` + `scripts/steps/waitlistDemandReport.js` | ranking/CSV aggregation + timestamped IMPEX export, mkdirs, error mapping |
  | SFRA client + controller | `client/notify.js`, `controllers/WaitList.js` | `shouldShowNotify` (resolved OOS variant **or** wholly sold-out master) / `buildSubscribeBody` / `stripWlNotified`, controller gating |
