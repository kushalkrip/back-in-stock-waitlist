# Notify Me / Back-In-Stock — UI/UX Design Spec

Status: **DESIGN ONLY — not implemented.** This document specifies behavior, states,
copy, and component boundaries for review. No production component in
`overrides/app/components/` should change as a result of this file.

> **Product decisions LOCKED (2026-08-28, confirmed by Kushal).** This doc is now the
> single canonical UI spec (the earlier `UI-SPEC.md` was merged into this and removed).
> 1. **Registered shopper → one-tap, silent authenticated email** (no prompt, no email field
>    at all). The subscribe request carries **no client-supplied email** — the backend derives
>    the address from the authenticated SLAS token/customer record. There is **no "use a
>    different email" override**. (§3.1)
> 2. **Guest shopper → "Sign in to be notified" login prompt, registered-users-only feature.**
>    Guests are NOT allowed to type an email. The OOS form shows a short line plus a sign-in
>    CTA that opens the existing `AuthModal`; after login the shopper is registered and gets
>    the one-tap path (#1) automatically. **This reverses the earlier "guest inline email"
>    design** (cut 2026-08-28) — allowing an anonymous shopper to enter any address is an
>    abuse vector (a single guest could subscribe 1,000 arbitrary addresses per SKU). Binding
>    every subscription to a verified, account-owned email eliminates that vector entirely.
>    (§3.2)
> 3. **Partial stock (want 6, only 5 left) → NOT a Notify-Me case.** Notify Me shows only
>    when the variant is fully out of stock (`stockLevel === 0`). When some stock exists,
>    the base retail-react-app behavior (inline inventory message, Add-to-Cart capped to
>    `stockLevel`) is left untouched and no waitlist affordance is shown. The earlier
>    "split buy box / shortfall notice" idea was **cut as over-engineering** (2026-08-30):
>    it is not a mainstream B2C pattern — the "want more than exists" case is a B2B
>    *backorder* convention, not a consumer waitlist. (§4)
> 4. **Already-subscribed is detected by a mount-time GET status check** (REVISED
>    2026-08-30 — this reverses the earlier "response-driven, no GET" call). On load
>    the PDP calls `GET .../subscriptions?sku=…`; if `subscribed:true` it renders a
>    passive "already on the list" state with no submit button. The idempotent POST
>    still returns a distinguishable `already-subscribed` status, so a two-tab race
>    also resolves to that state. **Why reversed:** response-driven detection cannot
>    survive a page reload (no request has been made yet on a fresh load), so a
>    subscribed shopper who refreshed saw the actionable button again and could
>    create a duplicate — the reported defect. Cost: one lightweight GET per PDP
>    load of an OOS variant for a registered shopper. (§5.4, §6.3)

Grounded against the actual code in this repo:
- `overrides/app/components/notify-me/index.jsx` (current `NotifyMeForm`)
- `overrides/app/components/product-view/index.jsx` (`renderActionButtons`, the
  Add-to-Cart ⇄ Notify-Me swap)
- `node_modules/@salesforce/retail-react-app/app/hooks/use-derived-product.js`
- `node_modules/@salesforce/retail-react-app/app/hooks/use-current-customer.js`
- `node_modules/@salesforce/commerce-sdk-react/hooks/useCustomerType.js`
- `node_modules/@salesforce/retail-react-app/app/hooks/use-auth-modal.js`
- `node_modules/@salesforce/retail-react-app/app/components/with-registration/index.jsx`
- `node_modules/@salesforce/retail-react-app/app/components/quantity-picker/index.jsx`

---

## 0. TL;DR — the three explicit product decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| 1 | Registered shopper: prompt for email? | **No — and no email field at all.** One-tap "Notify Me"; the request sends no email, the backend derives it from the authenticated token. No "use a different email" override. | The address is already known and *verified* server-side. Never trusting a client-supplied email removes both friction and the spoofed/typo'd-address risk. |
| 2 | Guest: force login vs. collect email inline? | **DECIDED: registered-users-only — guests get a "Sign in to be notified" prompt (opens `AuthModal`); no guest email entry.** | Letting an anonymous shopper type any address is an abuse vector (mass-subscribe 1,000 strangers per SKU). Binding every subscription to a verified, account-owned email closes it. Sign-in is one modal away and the shopper drops straight into the one-tap path. This reverses the earlier inline-email decision. |
| 3 | Partial stock (want 6, only 5 left)? | **Not a Notify-Me case.** Notify Me shows only when fully OOS (`stockLevel === 0`). For partial stock, leave the base app's existing behavior (inline inventory message + Add-to-Cart capped to `stockLevel`); no waitlist affordance. | A split "add 5 / waitlist the 6th" buy box isn't a mainstream B2C pattern — real storefronts are binary per SKU and the "want more than exists" case is B2B *backorder*, not a consumer waitlist. Cut as over-engineering. |

---

## 1. Real API surface this spec is grounded on

### 1.1 `useDerivedProduct(product, isProductPartOfSet, isProductPartOfBundle, pickupInStore, controlledVariationValues, onVariationChange)`
File: `node_modules/@salesforce/retail-react-app/app/hooks/use-derived-product.js`

Returns (fields this spec uses):

| Field | Meaning |
|---|---|
| `showLoading` | `!product` — product not yet fetched |
| `variant` | resolved variant object, or `undefined` until all variation attrs are picked |
| `variationAttributes` | array of `{id, name, selectedValue, values:[{value, orderable, ...}]}` |
| `stockLevel` | `product.inventory.stockLevel \|\| 0` — **this is the real ATS/orderable quantity** for the resolved variant/product |
| `quantity` / `setQuantity` | current quantity-picker value (controlled state owned by this hook) |
| `minOrderQuantity`, `stepQuantity` | picker bounds |
| `isOutOfStock` | `true` when `stockLevel === 0`, OR all variation attrs are selected but no variant resolves, OR the resolved variant exists but `!variant.orderable` |
| `unfulfillable` | **`stockLevel < quantity`** — i.e. some stock exists but less than the shopper is asking for. **This is the partial-stock flag; it exists today but is only used to fully disable Add-to-Cart.** |
| `showInventoryMessage` | `(variant \|\| bundle \|\| standard) && (isOutOfStock \|\| unfulfillable)` — drives `disableButton` in `product-view.jsx` today |
| `isSelectedStoreOutOfStock`, `selectedStore` | pickup-in-store equivalents of the above |

Key finding: **`isOutOfStock` (`stockLevel === 0` / not orderable) is the only signal this
feature needs.** `product-view.jsx`'s current binary `showNotifyMe` (Notify Me *replaces*
Add-to-Cart when OOS) is exactly the right shape — we keep it. `unfulfillable` (partial
stock) is deliberately **not** used to drive Notify Me; that stays the base app's inventory
message, per the LOCKED decision above.

### 1.2 Customer type / identity

- `useCustomerType()` — `node_modules/@salesforce/commerce-sdk-react/hooks/useCustomerType.js`.
  Real return shape: `{ customerType: null | 'guest' | 'registered', isGuest, isRegistered, isExternal }`.
  `customerType` is `null` during auth bootstrap — **must be treated as "unknown," not "guest."**
- `useCurrentCustomer(expand?, queryOptions?)` — `node_modules/@salesforce/retail-react-app/app/hooks/use-current-customer.js`.
  Wraps `useCustomer` (SCAPI Shopper Customers) + `useCustomerId` + `useCustomerType`.
  Returns `{ data: { ...customerRecord, customerType, customerId, isRegistered, isGuest }, isLoading, ... }`.
  For a registered shopper, `data.email` is the real field (confirmed used the same way in
  `pages/checkout/partials/contact-info.jsx` and `pages/account/profile.jsx`). The SCAPI
  `useCustomer` query is `enabled: !!customerId && isRegistered`, so `data.email` is
  `undefined` for guests — never crashes, just absent.
- `useAuthModal(initialView)` + `<AuthModal {...authModal} />` — `.../app/hooks/use-auth-modal.js`.
  Real, reusable login/register modal. `useAuthModal()` returns
  `{initialView, isOpen, onOpen, onClose, isPasswordlessEnabled, isSocialEnabled, idps}` to spread
  onto `<AuthModal>`. Views: `LOGIN_VIEW | REGISTER_VIEW | PASSWORD_VIEW | EMAIL_VIEW`
  (`EMAIL_VIEW` is the passwordless/OTP flow).
- `withRegistration(Component)` — `.../app/components/with-registration/index.jsx`.
  **This exact HOC is already imported in `product-view.jsx` today** (`ButtonWithRegistration`,
  used for the wishlist button). It wraps `onClick`: if `!customer.isRegistered`, it opens
  `AuthModal` instead of firing the click; on `onLoginSuccess` it re-fires the original
  handler. This is the *real, existing* mechanism for "gate this action behind login" — and
  since this feature is registered-users-only (LOCKED #2), it is exactly the seam the guest
  "Sign in to be notified" path uses (§3.2): a guest tap opens `AuthModal`, and on login
  success the form re-renders straight into the §3.1 one-tap state.

### 1.3 `QuantityPicker` — `.../app/components/quantity-picker/index.jsx`
Controlled Chakra `useNumberInput` wrapper. Relevant props as used in `product-view.jsx`:
`id`, `step`, `value`, `min`, `max?`, `onChange(stringValue, numberValue)`, `onBlur`, `onFocus`,
`productName` (used only to build the increment/decrement `aria-label`s, e.g.
*"Increment Quantity for {productName}"*, id `product_view.label.assistive_msg.quantity_increment`).
Already keyboard-accessible (Chakra `useNumberInput` + a documented Space/Enter-on-buttons patch).

### 1.4 Current `NotifyMeForm` gaps this spec must fix
Reading `overrides/app/components/notify-me/index.jsx` line by line:
- All copy is hardcoded English JSX text — **no `defineMessages`/`FormattedMessage`**, unlike
  every other string in `product-view.jsx`. Must be converted (see §7).
- No use of `customer.email` at all — always renders a blank email `Input`, even for a
  signed-in shopper who is one hook away (`useCurrentCustomer`).
  - Note: `useCurrentCustomer` is a **relative import from `retail-react-app/app/hooks`, not
    re-exported at the `@salesforce/retail-react-app` package root** — so it must be imported the
    same way `product-view.jsx` imports `useAuthModal`, i.e.
    `@salesforce/retail-react-app/app/hooks/use-current-customer`.
- The doc comment says "a 200 with status `already-subscribed` is treated as success
  (idempotent)" but `submitLive()` only checks `res.ok`, it never branches on response body —
  so today "already subscribed" and "newly subscribed" are visually identical. This spec makes
  that distinction explicit (§5.5) since it changes the copy shown.
- `state` is local to the form with no `aria-live` region — a screen reader user gets no
  announcement on submit success/failure.
- `sku` is required and taken from `variant?.productId || product?.id` in `product-view.jsx` —
  correct binding to variant already, this spec keeps it.
- `MOCK_MODE` / `WAITLIST_LIVE` toggle stays as-is; see §9 for what's mocked vs. real.

---

## 2. Decision / state matrix

Axes:
- **Customer type**: `unknown` (customerType===null, still resolving) / `guest` / `registered`
- **Variant resolution**: `no-variant` (master has variation attrs, none/partial selected) / `resolved`
- **Stock vs. requested qty**, using `stockLevel` (ATS) and `quantity` (picker value):
  - `OOS` — `stockLevel === 0` (or resolved variant not orderable)
  - `PARTIAL` — `0 < stockLevel < quantity` (i.e. `unfulfillable === true`)
  - `FULL` — `stockLevel >= quantity`

| # | Customer | Variant | Stock vs qty | Renders | Notes |
|---|---|---|---|---|---|
| 1 | any | `no-variant` | n/a | **Disabled Add-to-Cart** + "Please select all your options above" (existing `showOptionsMessage`) | No SKU to bind Notify Me to; unchanged from today. Do not show Notify Me. |
| 2 | any | resolved | `FULL` | **Add-to-Cart** (enabled) | Baseline path, unchanged. |
| 3 | `unknown` | resolved | `OOS` | **Add-to-Cart button in disabled/skeleton state** (neither one-tap nor login prompt yet) | Avoid flashing "guest" copy then "registered" copy. Treat like `showLoading`. |
| 4 | `registered` | resolved | `OOS` | **Mount-time GET status check** → if not subscribed: **Notify Me one-tap, no email field** (§3.1); if already subscribed: passive "already on the list" (row #8). A skeleton shows while the check is in flight. | Email is server-derived from the token; the client sends no address. |
| 5 | `guest` | resolved | `OOS` | **"Sign in to be notified" login prompt** (§3.2) — CTA opens `AuthModal`; on login success the form becomes row #4 | Registered-users-only feature (LOCKED #2). No guest email entry. |
| 6 | `registered` | resolved | `PARTIAL` | **Add-to-Cart only** — base app behavior (inline "Only N left" message, qty capped to `stockLevel`). **No Notify Me.** | §4. Partial stock is not a waitlist case (LOCKED decision #3). |
| 7 | `guest` | resolved | `PARTIAL` | **Add-to-Cart only** — same as #6. **No Notify Me.** | §4. |
| 8 | `registered` | resolved, already subscribed for this sku+email | `OOS` | **Passive "already on the list" state — no submit button** (§5.4). Entered directly on mount when the GET status check returns `subscribed:true`; also reached if the idempotent POST returns `already-subscribed` (two-tab race). | Mount-time GET status check (LOCKED decision #4, REVISED 2026-08-30). See §5.4/§6.3. |
| 9 | any | resolved | `OOS`, product is a Set or Bundle | **No Notify Me.** Keep current behavior: sets/bundles never show Notify Me (`!isProductASet && !isProductABundle` guard already in `product-view.jsx`) | Out of scope — bundle-of-bundles back-in-stock is a separate spec. |
| 10 | any | resolved | `OOS`, child-of-bundle | **Nothing rendered** (bundle children have no CTA row at all today — `!isProductPartOfBundle` guard) | Unchanged. |
| 11 | any (`forceOOS=1` query param) | resolved | any | **Notify Me forced on**, dev/demo override | Preserves the existing `forceOOS` debug hook in `product-view.jsx`; keep it, but it should force the *matrix row for the real customer type*, not a hardcoded guest view. |

Pseudocode consolidating the matrix (see §6 for the full derivation) — this stays the
existing binary `showNotifyMe`, unchanged in shape:

```
showAddToCart  = variantResolved && !isOutOfStock         // FULL and PARTIAL (base app caps qty)
showNotifyMe   = variantResolved && (isOutOfStock || forceOOS)
// binary: Notify Me REPLACES Add-to-Cart when fully OOS; the two never coexist.
// PARTIAL stock is NOT a Notify-Me trigger — base app inventory message handles it.
```

---

## 3. Registered one-tap and the guest login prompt

This is a **registered-users-only** feature (LOCKED #2). There are exactly two idle renders:
a signed-in shopper gets one-tap Notify Me (§3.1); a guest gets a "Sign in to be notified"
prompt (§3.2). No shopper ever types an email address into this form.

### 3.1 Registered shopper — one-tap, no email field

Default render: no input field, no email echoed for editing. Button reads **"Notify Me"**;
a short subtext confirms where the alert will go, using the known account email purely as
*display* — it is not an editable value and it is **not sent** in the request.

```
┌──────────────────────────────────────────────┐
│ Out of stock                                  │
│ We'll email you the moment Size 9 is back.    │
│                                                │
│  📧  We'll notify you at ann@example.com       │
│                                                │
│  [        Notify Me        ]                  │
└──────────────────────────────────────────────┘
```

There is **no "use a different email" override.** The subscribe request sends only `{sku,
locale}`; the backend resolves the email from the authenticated SLAS token / customer record
(see HLD API section). This means the client never chooses or transmits an address — the one
we notify is always the verified account email, which removes both the friction of re-asking
and the risk of a spoofed or mistyped address.

### 3.2 Guest shopper — "Sign in to be notified" prompt

A guest cannot subscribe directly. The OOS form shows a short explanation and a single
sign-in CTA; there is **no email input and no "continue as guest" escape hatch.**

```
┌──────────────────────────────────────────────┐
│ Out of stock                                  │
│ Sign in and we'll notify you at your account  │
│ email the moment this is back.                 │
│                                                │
│  [       Sign in to be notified      ]         │
└──────────────────────────────────────────────┘
```

"Sign in to be notified" opens `AuthModal` via `useAuthModal()`, mirroring the
`withRegistration` HOC pattern already used for the wishlist button in `product-view.jsx`.
On `onLoginSuccess`, `customer.isRegistered` flips true and the form re-renders into the
§3.1 one-tap state automatically (same mechanism `withRegistration` relies on for its
re-fire), so a shopper who signs in from this CTA lands one tap away from being on the list.

**Why registered-only (reverses the earlier guest-inline-email design).** Allowing an
anonymous shopper to type any address turns a passive opt-in into an abuse vector: one guest
could subscribe 1,000 arbitrary strangers to a SKU (an email-bombing / harassment vector),
and every such address is unverified, so bounces and spam complaints accrue against the
sending domain. Requiring sign-in binds every subscription to a **verified, account-owned**
email and eliminates the arbitrary-recipient vector at the source — no rate-limiting or
double-opt-in gymnastics needed to make the guest path safe, because there is no guest path.
The cost is the well-known login-wall drop-off on a low-commitment action; we accept it here
because the abuse and deliverability downside of anonymous arbitrary-email entry is the
larger risk for this specific feature, and sign-in is a single reusable modal away.

---

## 4. Stock rules — when Notify Me shows

Notify Me is **binary and fully-OOS-only**. It replaces Add-to-Cart when the resolved
variant has zero orderable stock, and is never shown while any stock exists. Partial stock
(shopper wants more than is available) is **not** a waitlist case — it stays the base
retail-react-app behavior. This is the LOCKED decision #3 above; the earlier split buy box /
shortfall-notice design was cut as over-engineering (it isn't a mainstream B2C pattern — the
"want more than exists" case is a B2B *backorder* convention, not a consumer waitlist).

### 4.1 Rule of record

```
stockLevel   = derived.stockLevel        // ATS for resolved variant/product
quantity     = derived.quantity          // shopper's requested qty (QuantityPicker value)
isOutOfStock = derived.isOutOfStock      // stockLevel === 0 || variant unresolved-with-full-selection || !variant.orderable
unfulfillable = derived.unfulfillable    // stockLevel < quantity  (true even if stockLevel > 0)

case OOS:      stockLevel === 0 (or !orderable)
  -> Add-to-Cart: HIDDEN
  -> Notify Me:   FULL FORM (per §3) — replaces Add-to-Cart entirely

case PARTIAL:  0 < stockLevel < quantity   (unfulfillable === true)
  -> Add-to-Cart: SHOWN — base app behavior: inline "Only N left" inventory message,
                  qty capped to stockLevel. UNCHANGED by this feature.
  -> Notify Me:   HIDDEN — the SKU is still orderable, so no waitlist affordance.

case FULL:     stockLevel >= quantity
  -> Add-to-Cart: SHOWN, ENABLED, at requested qty
  -> Notify Me:   HIDDEN
```

### 4.2 Partial stock — no special handling

We deliberately do **not** touch the partial-stock path. `unfulfillable` continues to feed
the base app's `showInventoryMessage` (the existing "Only 5 left" message + capped/disabled
Add-to-Cart). No new component, no shortfall control, no `requestedQty` telemetry. A shopper
who wants more units than exist buys what's available; the "want more than exists" desire is
not captured as a waitlist row.

### 4.3 Fully-OOS (0 stock) case
The `OOS` branch above is the existing/primary case the current `NotifyMeForm` was built for.
The current binary "replace Add-to-Cart entirely" rule is exactly right and is kept as-is —
this feature adds nothing to the partial branch.

### 4.4 Master-product-with-no-variant-selected case
`variantResolved = Boolean(variant?.productId) || !hasVariations` (existing logic in
`product-view.jsx`, kept as-is). While `!variantResolved`:
- Add-to-Cart: disabled, existing "Please select all your options above" message.
- Notify Me: **hidden entirely.** We deliberately do not offer "notify me for any size" —
  the SCAPI waitlist payload requires a concrete `sku` (`variant?.productId || product?.id`),
  and a master-level subscription is a different feature (see §10, out of scope) that would
  need its own SCAPI contract (subscribe-to-master, fan out to variants at fulfillment time).

---

## 5. State model (per NotifyMeForm instance, keyed by sku)

```
checking → idle → sending → done
   │         ↓        ↑
   │       error ──────┘ (retry re-enters sending)
   └──────→ already-subscribed   (mount-time GET status check says subscribed)
                    ↑
            done path also enters here if POST returns already-subscribed
```

### 5.0 checking (registered only, on mount)
The registered branch starts in `checking` while the mount-time `GET
.../subscriptions?sku=…` status lookup is in flight, and renders a skeleton — we
never flash the actionable "Notify me" button before we know whether the shopper
is already subscribed (otherwise a reload could invite a duplicate signup, the
reported defect). Resolves to `already-subscribed` (`subscribed:true`) or `idle`
(`subscribed:false`); on lookup failure it **fails open to `idle`** so the shopper
can still subscribe. Under `MOCK_MODE` the check reads a localStorage stand-in for
the Custom Object. Guests skip this entirely (they can't be subscribed).

### 5.1 idle
Default render per customer-type variant (§3). For a registered shopper the "Notify Me"
button is enabled immediately (no email to enter — it's server-derived). For a guest the
only control is the "Sign in to be notified" CTA; there is no submittable form until they
sign in and the view becomes the registered one-tap variant.

### 5.2 sending
Button shows Chakra `isLoading` spinner (`<Button isLoading>`, same prop already used in
`product-view.jsx`'s Add-to-Cart and wishlist buttons — consistent affordance). Email input
(if shown) becomes `isDisabled`. Re-submit is blocked (`if (state === 'sending') return`,
already correct in current code).

### 5.3 done (success, first-time subscription)
Replaces the form with a confirmation card. No further action available except implicitly
navigating away — this is a fire-and-forget flow, not a persistent widget.

### 5.4 already-subscribed (idempotent)
Distinct from `done`: rendered when the backend reports the email+sku pair already exists.
Softer tone ("you're already on the list" rather than "you're on the list now"), same visual
container as `done` so there's no jarring layout shift, but copy makes it clear no duplicate
signup happened.

**Detection is a mount-time GET status check (LOCKED decision #4, REVISED 2026-08-30).**
This reverses the earlier "response-driven only, no GET" call. Two entry points now feed
this state:

- **On mount:** the `GET .../subscriptions?sku=…` status check returns `subscribed:true`
  → the form renders `already-subscribed` directly, with **no submit button**. This is the
  case that fixes the reported defect (a reload no longer re-shows an actionable button).
- **On submit (race):** the idempotent POST returns `already-subscribed` → the form flips
  from `sending` into `already-subscribed` (`submitLive()` reads the parsed body and returns
  `{ok, already}`; `submitMock()` returns `already:false`).

**Why the reversal:** response-driven detection alone cannot survive a page reload — no
request has been made yet on a fresh load, so a subscribed shopper saw the actionable button
again. The cost of the fix is one lightweight GET per PDP load of an OOS variant for a
registered shopper, which is an acceptable price for non-duplicating UX. Under `MOCK_MODE`
the status check (and the submit's persistence) use a localStorage stand-in for the Custom
Object, so the "already subscribed after refresh" behaviour is demoable without a backend.

### 5.5 error / retry
Inline error text below the button (as today), button reverts to enabled non-loading state,
email value is preserved (not cleared) so the shopper doesn't retype. A "Try again" affordance
is just the same submit button re-enabled — no separate button needed.

### 5.6 network failure (subtype of error)
Same visual state as 5.5, but copy distinguishes "couldn't reach the server" from "the server
rejected the request" where the client can tell the difference (e.g. `fetch` throwing vs.
`res.ok === false`), because the retry advice differs (check connection vs. just retry).

---

## 6. Behavioral rules — pseudocode

### 6.1 `product-view.jsx` — the binary `showNotifyMe` (kept as-is in shape)

```js
// Inputs from useDerivedProduct + product-view local state (all real fields, §1.1):
const hasVariations = product?.variationAttributes?.length > 0
const selectedSku = variant?.productId || product?.id
const variantResolved = Boolean(variant?.productId) || !hasVariations
const forceOOS = new URLSearchParams(location.search).get('forceOOS') === '1'

const isEligibleProduct =
  !showLoading && !isProductASet && !isProductABundle && !isProductPartOfBundle &&
  Boolean(selectedSku) && variantResolved

const isFullyOOS   = isEligibleProduct && (isOutOfStock || forceOOS)

const showNotifyMe  = isFullyOOS                                 // fully-OOS only; never for PARTIAL
const showAddToCart = isEligibleProduct && !isFullyOOS           // FULL and PARTIAL (base app caps qty)
// PARTIAL stock is intentionally NOT handled here — `unfulfillable` keeps feeding the base
// app's showInventoryMessage untouched (see §4). No shortfall component, no requestedQty.
```

### 6.2 Inside `NotifyMeForm` — customer-type branching

```js
const {data: customer} = useCurrentCustomer()

const identity =
  customer.customerType === null            ? 'unknown'    :
  customer.isRegistered                     ? 'registered' :
  /* isGuest */                               'guest'

// idle-state sub-view selection (mount-time + reactive to login state changes).
// Registered-users-only: exactly three views, no config flag, no guest email path.
const idleView =
  identity === 'unknown'      ? 'skeleton'      :  // still resolving — no flash of guest copy
  identity === 'registered'   ? 'silent-email'  :  // §3.1 one-tap, no field
  /* identity === 'guest' */    'login-prompt'      // §3.2 "Sign in to be notified"

// The client never holds or sends an email. For a registered shopper `customer.email` is
// used only as DISPLAY text; the subscribe request body is {sku, locale} and the backend
// derives the address from the authenticated token. A guest has no submit path at all.
const displayEmail = identity === 'registered' ? customer.email : undefined
```

### 6.3 Already-subscribed — response-driven (LOCKED decision #4)

No mount-time existence check. The state is derived from the POST result on submit:

```js
async function onSubmit(e) {
  e.preventDefault()
  if (state === 'sending') return
  setState('sending')
  try {
    const result = MOCK_MODE ? await submitMock() : await submitLive()
    // submitLive/submitMock now return a tri-state, not a boolean:
    //   'created' | 'already-subscribed' | 'error'
    setState(
      result === 'created'            ? 'done' :
      result === 'already-subscribed' ? 'already-subscribed' :
                                        'error'
    )
  } catch (err) {
    setState(err.isNetwork ? 'error-network' : 'error')
  }
}
```

`submitLive()` maps the HTTP response: `201 → 'created'`, `200 → 'already-subscribed'`,
anything else → `'error'` (see §9 and the HLD for the exact backend contract). This replaces
the current `return res.ok` boolean.

---

## 7. Component breakdown

```
ProductView (overrides/app/components/product-view/index.jsx)
└─ renderActionButtons()
   ├─ <Button> Add to Cart                                (existing, unchanged)
   └─ {showNotifyMe && <NotifyMeForm sku={selectedSku} locale={intl.locale} />}
      // binary swap: shown only when fully OOS, replaces Add-to-Cart (no slot/variant indirection)

NotifyMeForm (overrides/app/components/notify-me/index.jsx — reworked)
├─ useCurrentCustomer()            // identity + customer.email (display only)
├─ useAuthModal() + <AuthModal>    // only mounted when idleView === 'login-prompt' (guest)
├─ <NotifyMeIdentityBlock>         // renders one of:
│   ├─ <SilentEmailNotice email />        // §3.1 registered — email is display text only
│   └─ <LoginPromptNotify onSignIn />     // §3.2 guest — "Sign in to be notified"
│   (no guest email input exists — this feature is registered-users-only)
├─ <Button> Notify Me / spinner / disabled   // rendered only in the registered view
├─ <FormStatusRegion aria-live="polite">             // §8 — wraps error/done/already-subscribed text
└─ (already-subscribed / done render replaces the whole form body, keeps outer Box)
```

### Proposed props

**`NotifyMeForm`**
| Prop | Type | Notes |
|---|---|---|
| `sku` | `string`, required | variant/product id — unchanged from today |
| `locale` | `string` | unchanged |
| `initialState` | `'idle' \| 'already-subscribed'`, optional, default `'idle'` | lets a parent short-circuit into the idempotent view, without a flash of the idle form |

Note there is **no `email` prop and no email-collection callback anywhere** — the address is
never client-held. The subscribe request body is `{sku, locale}`; the backend derives the
email from the authenticated token.

**`LoginPromptNotify`** (new — the guest view)
| Prop | Type | Notes |
|---|---|---|
| `onSignIn` | `() => void` | opens `AuthModal` (reuses `useAuthModal()`); on login success the parent re-renders into the registered one-tap view |

**`SilentEmailNotice`** (new — the registered view)
| Prop | Type | Notes |
|---|---|---|
| `email` | `string`, required | `customer.email`, shown as confirmation text only — **not** an input, **not** submitted |

None of these are wired into `product-view.jsx` in this pass — this is the seam
recommendation, not a patch.

---

## 8. Accessibility

Grounded in the same Chakra UI + react-intl conventions already used elsewhere in
`product-view.jsx` and `quantity-picker/index.jsx`:

1. **Focus management.**
   - On swap from Add-to-Cart → Notify Me form (OOS case), move focus to the form's heading
     (`tabIndex={-1}` on a `<Box as="h3">`, focused via `ref.current.focus()` on mount) — mirrors
     the existing pattern in `product-view.jsx` where `errorContainerRef.current.scrollIntoView()`
     is used for the "select all options" error; here we go one step further and actually focus,
     since a whole interactive region just appeared where a button used to be.
   - On submit success (`done` / `already-subscribed`), do **not** steal focus away from the
     button that was just clicked (avoid the common bug where a live-region swap yanks focus off
     the previously-focused control) — keep focus on the (now-hidden) submit button's former
     DOM position by focusing the confirmation card's container instead, consistent with the
     `errorContainerRef` scroll target pattern used elsewhere in this file.
   - On `LoginPromptNotify` → `AuthModal` open, Chakra's `<Modal>` already traps focus and returns
     it to the trigger element on close (this is default Chakra `Modal` behavior, already relied
     on implicitly wherever `AuthModal`/`useAuthModal` is used in this codebase, e.g.
     `with-registration/index.jsx`) — no extra work needed here.

2. **`aria-live` for state transitions.** Wrap the status region (error text, success text,
   already-subscribed text) in a single persistent container with `aria-live="polite"` and
   `aria-atomic="true"`, e.g.:
   ```jsx
   <Box aria-live="polite" aria-atomic="true">
     {state === 'error' && <Text color="red.500">{...}</Text>}
     {state === 'done' && <Text>{...}</Text>}
     {state === 'already-subscribed' && <Text>{...}</Text>}
   </Box>
   ```
   Keep this box always mounted (not conditionally rendered as a whole) so screen readers pick
   up the *change* in its content — conditionally mounting/unmounting the live region itself is
   a common failure mode that silently drops the announcement.

3. **No email input to label.** The current code's bare `<Input placeholder="you@example.com">`
   should be **removed entirely** — this feature is registered-users-only and the email is
   server-derived, so there is no text field to collect an address (and therefore no
   placeholder-vs-label pitfall). The registered view's email is rendered as static
   confirmation `Text`, not an input; the guest view has only the sign-in CTA.

4. **Keyboard.** Form is a native `<Box as="form" onSubmit>` already (correct — Enter submits).
   No custom keyboard trap. The only interactive controls are the "Notify Me" submit button
   (registered) and the "Sign in to be notified" CTA (guest) — both plain
   buttons/links, natively focusable and activatable, no `role="button"` on a `<div>` anywhere.

5. **Error announcement.** Submit errors (network/server) can still occur on the registered
   one-tap path. Since there is no text input to attach to, associate the error with the
   **submit button** via `aria-describedby` pointing at the error text's `id`, in addition to
   placing it inside the `aria-live` region from point 2 (belt-and-suspenders: `aria-live`
   announces the change even if focus moved; `aria-describedby` re-reads it when focus returns
   to the button).
   ```jsx
   <Button aria-describedby={state === 'error' ? 'notify-me-error' : undefined} isLoading={state === 'sending'}>...</Button>
   ...
   {state === 'error' && <Text id="notify-me-error" color="red.500">...</Text>}
   ```

6. **Loading state.** `<Button isLoading>` (Chakra) already sets `aria-busy` under the hood —
   keep using the Chakra prop rather than a hand-rolled spinner, consistent with every other
   button in `product-view.jsx`.

---

## 9. i18n — message keys and copy

Following this codebase's existing `id` convention (`<component>.<category>.<description>`,
e.g. `product_view.label.quantity`, `use_product.message.out_of_stock`), all new copy goes
under a `notify_me.*` namespace via `defineMessages`, replacing the current hardcoded JSX
strings in `overrides/app/components/notify-me/index.jsx`.

```js
import {defineMessages} from 'react-intl'

export const messages = defineMessages({
  // Full OOS heading (registered + guest share the heading)
  heading: {
    id: 'notify_me.heading.out_of_stock',
    defaultMessage: 'Out of stock'
  },

  // Registered — one-tap, no email field (§3.1)
  bodyRegistered: {
    id: 'notify_me.body.registered',
    defaultMessage: "We'll email you the moment this is back in stock."
  },
  silentEmailNotice: {
    id: 'notify_me.body.silent_email_notice',
    defaultMessage: "We'll notify you at {email}"
  },

  // Guest — "Sign in to be notified" prompt (§3.2). No guest email keys: this feature is
  // registered-users-only, so there is no placeholder/label/inline-email/continue-as-guest copy.
  bodyGuestLogin: {
    id: 'notify_me.body.guest_login',
    defaultMessage:
      "Sign in and we'll notify you at your account email the moment this is back."
  },
  signInCta: {
    id: 'notify_me.action.sign_in_cta',
    defaultMessage: 'Sign in to be notified'
  },

  // Submit button (registered view only)
  submitCta: {
    id: 'notify_me.action.submit',
    defaultMessage: 'Notify Me'
  },

  // (Partial-stock / shortfall keys removed — partial stock is not a Notify-Me case, §4)
  // (Guest inline-email + email-validation keys removed — no client-supplied email, §3)

  // Success / idempotent
  successHeading: {
    id: 'notify_me.status.success_heading',
    defaultMessage: "You're on the list!"
  },
  successBody: {
    id: 'notify_me.status.success_body',
    defaultMessage: "We'll email {email} the moment this is back in stock."
  },
  alreadySubscribedHeading: {
    id: 'notify_me.status.already_subscribed_heading',
    defaultMessage: "You're already on the list"
  },
  alreadySubscribedBody: {
    id: 'notify_me.status.already_subscribed_body',
    defaultMessage: "We'll email {email} as soon as this is back — no need to sign up twice."
  },

  // Errors
  errorGeneric: {
    id: 'notify_me.error.generic',
    defaultMessage: 'Something went wrong. Please try again.'
  },
  errorNetwork: {
    id: 'notify_me.error.network',
    defaultMessage: "Couldn't reach the server. Check your connection and try again."
  },

  // Accessibility-only strings
  formHeadingAssistive: {
    id: 'notify_me.label.assistive_form_heading',
    defaultMessage: 'Back in stock notification signup'
  }
})
```

All keys follow this codebase's existing `defineMessages` + `id` convention, consistent with
how `react-intl`/FormatJS is already used throughout the SDK (`use-auth-modal.js`,
`use-derived-product.js`, etc.) — no new dependency.

---

## 10. Analytics / telemetry hooks

Not implemented here — noted as integration points for whatever analytics layer this
storefront already uses (Einstein/CDP tags are wired elsewhere in `retail-react-app`, not
inspected as part of this task):

| Event | Fired when | Suggested payload |
|---|---|---|
| `notify_me_viewed` | `NotifyMeForm` mounts | `sku`, `identity` (`registered/guest/unknown`) |
| `notify_me_submitted` | form submit fires (before network resolves) | `sku`, `identity` |
| `notify_me_success` | `state → done` | `sku`, `identity` |
| `notify_me_already_subscribed` | `state → already-subscribed` (response-driven, §6.3) | `sku`, `identity` |
| `notify_me_error` | `state → error` | `sku`, `errorType` (`network` \| `server`) |
| `notify_me_login_prompt_shown` | `LoginPromptNotify` renders (guest sees the sign-in CTA) | `sku` |
| `notify_me_login_prompt_signin_clicked` | guest clicks "Sign in to be notified" (opens `AuthModal`) | `sku` |

---

## 11. ASCII wireframes

**Registered, one-tap (§3.1, idle):**
```
┌──────────────────────────────────────────────┐
│ Out of stock                                  │
│ We'll email you the moment this is back.       │
│                                                │
│ 📧 We'll notify you at ann@example.com         │
│                                                │
│ [            Notify Me            ]            │
└──────────────────────────────────────────────┘
  (no email field, no override — the address is
   server-derived from the authenticated token)
```

**Guest — "Sign in to be notified" (§3.2, idle, the only guest render):**
```
┌──────────────────────────────────────────────┐
│ Out of stock                                  │
│ Sign in and we'll notify you at your account  │
│ email the moment this is back.                 │
│                                                │
│ [       Sign in to be notified     ]           │
└──────────────────────────────────────────────┘
  (registered-users-only: no email input, no
   "continue as guest". CTA opens AuthModal; on
   login the panel becomes the registered one-tap.)
```

**Partial stock (§4, either identity) — no waitlist affordance:**
```
┌──────────────────────────────────────────────┐
│ ⓘ Only 5 left                                 │
│ [        Add 5 to Cart        ]                │
└──────────────────────────────────────────────┘
  (base retail-react-app inventory message + capped
   Add-to-Cart; Notify Me is NOT shown — the SKU is
   still orderable. See §4.)
```

**Success (registered or guest, identical container):**
```
┌──────────────────────────────────────────────┐
│ You're on the list!                            │
│ We'll email ann@example.com the moment this   │
│ is back in stock.                              │
└──────────────────────────────────────────────┘
```

**Already-subscribed (idempotent, distinct copy, same container):**
```
┌──────────────────────────────────────────────┐
│ You're already on the list                     │
│ We'll email ann@example.com as soon as this   │
│ is back — no need to sign up twice.            │
└──────────────────────────────────────────────┘
```

**Error (registered one-tap; no input row — error attaches to the button, §8.5):**
```
┌──────────────────────────────────────────────┐
│ Out of stock                                  │
│ We'll email you the moment this is back.       │
│                                                │
│ 📧 We'll notify you at ann@example.com         │
│ [            Notify Me            ]            │
│ ⚠ Something went wrong. Please try again.      │
└──────────────────────────────────────────────┘
```

**Sending (loading):**
```
┌──────────────────────────────────────────────┐
│ Out of stock                                  │
│ We'll email you the moment this is back.       │
│                                                │
│ 📧 We'll notify you at ann@example.com         │
│ [         ⟳ Notify Me (disabled)     ]         │
└──────────────────────────────────────────────┘
```

---

## 12. What's real vs. mocked today, and what needs sandbox/SLAS work

Grounded in `overrides/app/components/notify-me/index.jsx`'s own doc comment plus its code:

| Piece | Works today (demo instance, `MOCK_MODE`) | Needs the real `custom/waitlist/v1` endpoint / sandbox |
|---|---|---|
| Rendering the form, states idle/sending/done/error | Yes — `submitMock()` simulates a 700ms delay then resolves `true` | n/a |
| `customer.email` for registered shoppers (display only) | Yes — `useCurrentCustomer`/`useCustomerType` run against the shared demo instance's real SLAS auth; used only to render the "we'll notify you at …" confirmation, never sent in the request | n/a — the endpoint derives the email from the token, not the body |
| `useAuthModal`/`AuthModal` login flow (the guest path) | Yes — standard SLAS registered-user login, works against the demo instance as-is; this is now the only guest affordance (registered-users-only) | n/a |
| POST to `/custom/waitlist/v1/.../subscriptions` | **No** — only exists on `zzft-025` per the existing comment; `MOCK_MODE` exists specifically to avoid calling it | Yes — must deploy the custom SCAPI endpoint + point config at `zzft-025` (or wherever it lands) with a real SLAS client id, then flip `WAITLIST_LIVE=true` |
| Idempotent "already-subscribed" detection (§5.4, §6.3) | **Mockable** — `submitMock()` can return the `already-subscribed` branch to demo the state | Yes — **DECIDED (#4): the POST response carries a distinguishable status** (`201 created` vs `200 already-subscribed`); NO separate read endpoint. `submitLive()` must be upgraded from `return res.ok` to a tri-state read of the body/status. |
| Partial-stock handling (§4) | Yes — unchanged base app behavior (inline "Only N left" + capped Add-to-Cart from the live Shopper Products API). **Not a Notify-Me case**, so nothing new to build or mock here | n/a — no waitlist submission on the partial path |
| Analytics events (§10) | Not wired to anything — this repo doesn't appear to have an existing analytics dispatch call site inspected as part of this task | Needs whatever analytics/CDP hook the rest of the storefront uses — out of scope to identify here |

---

## 13. Explicitly out of scope

- Master-product-level "notify me for any variant" subscriptions (§4.4) — would need a new
  SCAPI contract (subscribe to master, fan out at fulfillment), not just a UI change.
  Bundles/Sets remaining excluded entirely (existing guard, unchanged).
- Unsubscribe / manage-subscriptions UI (e.g. from an email link or account page) — this spec
  only covers the PDP subscribe flow.
- Rate limiting / abuse prevention on the subscribe endpoint (backend concern, not UI).
  Note the biggest abuse vector — an anonymous shopper subscribing arbitrary third-party
  addresses — is already closed at the design level by the registered-users-only decision
  (§3.2): every subscription is bound to a verified, account-owned email. Per-account /
  per-SKU caps remain a sensible backend defense-in-depth, specified in the HLD, not here.
- Localization of the actual outbound "it's back in stock" email content — this spec covers
  only the PDP form's own copy.
