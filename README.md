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
It runs in **MOCK_MODE** by default (submit simulates a successful call) because the custom
endpoint lives on our sandbox and the live path needs a SLAS client — see
[`cartridge/README.md`](cartridge/README.md) and `docs/HLD.md §12`. Set `WAITLIST_LIVE=true`
at build time once the endpoint is deployed.

**Cartridge (backend):** deploy `cartridge/app_waitlist` to the sandbox and import
`cartridge/metadata/back_in_stock/`. Full steps in [`cartridge/README.md`](cartridge/README.md).

## Testing

- **Jest** component tests cover the frontend identity branches
  (skeleton / guest / registered one-tap / done / error) — `cd storefront && npm test`.
- **Playwright** E2E specs drive the running PWA (guest sign-in prompt, mock submit,
  the `?forceOOS=1` demo helper) — see `storefront/` test setup.
