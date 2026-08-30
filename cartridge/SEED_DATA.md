# Route A — Getting "a few products" into the sandbox (incl. an out-of-stock one)

Your `zzft-025` sandbox is empty (the **Select a Site** dropdown is blank → no site,
no catalog, no inventory). PWA Kit renders nothing until a site + catalog + inventory
exist. You do **not** hand-author products for this — importing standard demo data is
faster, more reliable, and gives you realistic variation products (size/color) with
images and prices that PWA Kit renders out of the box. Then you just flip **one variant**
to out-of-stock.

---

## Step 1 — Load a site + catalog + inventory (pick ONE)

**Option 1a (recommended): import RefArch/RefArchGlobal demo data.**
This is the same dataset PWA Kit's `retail-react-app` template expects (`RefArchGlobal`).
- Get the demo-data archive from **Adyen** (ask: "is there a RefArch/SFRA demo-data import
  for zzft-025, or should I import my own?"), or from the public
  [`storefront-reference-architecture`](https://github.com/SalesforceCommerceCloud/storefront-reference-architecture)
  repo (ships a demo-data/site-import bundle).
- Import it: **Administration → Site Development → Site Import & Export → Upload** the zip,
  then **Import**. When it finishes, the **Select a Site** dropdown shows `RefArch` /
  `RefArchGlobal` and Merchant Tools shows a full catalog + inventory list.

**Option 1b (fallback, minimal): create a tiny catalog by hand.** Only if you can't get demo
data. It won't showcase variant-level resolution as richly and needs a price book + images
to render cleanly in PWA Kit. Sketch:
1. Merchant Tools → Products and Catalogs → **Catalogs** → New (`waitlist-demo-catalog`),
   mark it the site's **storefront catalog**.
2. Add a **variation master** with a `size` variation attribute and 2–3 variants (this is
   what lets you demo variant-level OOS). Standard products work too but only show the
   single-SKU path.
3. Merchant Tools → Products and Catalogs → **Price Books** → add list prices (else PWA
   shows no price / treats it as unbuyable).
4. Site → **Inventory** → create/assign an inventory list, add records for each variant.

> The demo-data route (1a) collapses steps 1b.1–1b.4 into one import. Prefer it.

---

## Step 2 — Make ONE variant out-of-stock

This is what your PDP component keys on, and what you flip live in the demo.

1. Merchant Tools → **Inventory** → select the site's inventory list.
2. Find a **variation product**, expand to its variants.
3. Pick one variant SKU (note it — this is your demo SKU). Set:
   - **Allocation = 0**, or
   - uncheck **Available** / set **stock level 0** so `orderable` becomes `false`.
4. Leave a sibling variant in stock, so you can demo the swap: OOS variant → **Notify Me**,
   in-stock variant → **Add to Cart**.

To demo the notify flow later, you'll set this same SKU's allocation back to a positive
number ("restock") and run the job.

---

## Step 3 — Note the values PWA Kit + the SCAPI call need

You'll drop these into PWA Kit's `config/default.js` and they parameterize the endpoint URL:

| Value | Where to find it |
|---|---|
| **siteId** | now visible in the Select-a-Site dropdown (e.g. `RefArchGlobal`) |
| **shortCode** | Administration → Site Development → **Salesforce Commerce API Settings** |
| **organizationId** | `f_ecom_zzft_025` (realm_instance format) — confirm in the same SCAPI Settings page |
| **SLAS clientId** | from Adyen (needs SLAS Org Admin to create) — the one still-open dependency |
| **your OOS variant SKU** | the SKU you zeroed in Step 2 |

---

## Optional — script the OOS toggle via inventory import

Instead of clicking, you can import an inventory override. Replace the list id and product
ids with your instance's values (get the list id from Merchant Tools → Inventory).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<inventory xmlns="http://www.demandware.com/xml/impex/inventory/2007-05-31">
  <inventory-list list-id="YOUR-INVENTORY-LIST-ID">
    <use-bundle-inventory-only>false</use-bundle-inventory-only>
    <records>
      <record product-id="YOUR-OOS-VARIANT-SKU">
        <allocation>0</allocation>
        <perpetual>false</perpetual>
      </record>
      <record product-id="YOUR-INSTOCK-VARIANT-SKU">
        <allocation>25</allocation>
        <perpetual>false</perpetual>
      </record>
    </records>
  </inventory-list>
</inventory>
```

Import via Administration → Site Development → Site Import & Export (place under
`inventory-lists/` in the archive).
