'use strict';

/**
 * Shared, storefront-agnostic aggregation of WaitlistSubscription custom
 * objects into a per-SKU demand report. BOTH report surfaces read through this
 * one function, so the ranking/CSV logic never diverges:
 *   - the Business Manager page  (bm_waitlist/controllers/WaitlistReport.js)
 *   - the scheduled export step  (app_waitlist/.../steps/waitlistDemandReport.js)
 *
 * The custom object is written identically by the SFRA controller
 * (WaitList-Subscribe) and the PWA custom SCAPI endpoint (rest-apis/waitlist),
 * both via scripts/helpers/waitlistSubscribe.js. This reader therefore neither
 * knows nor cares which channel produced a row -- it aggregates the persisted
 * data through server-side APIs only, which is exactly what makes the report
 * channel-agnostic.
 *
 * CustomObjectMgr's query API has no GROUP BY, so we iterate once and tally
 * into a map keyed by SKU (custom.productID). For very large subscription
 * volumes, prefer the job step (chunked/schedulable) over the live BM page.
 */

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var ProductMgr = require('dw/catalog/ProductMgr');

var OBJECT_TYPE = 'WaitlistSubscription';

/**
 * Catalog state of a SKU -- deliberately ORTHOGONAL to demand.
 *
 * Demand magnitude is the raw `waiting` count (see build()'s sort): it is the
 * one signal that stays meaningful whether a merchant has three shoppers or
 * three million, so it needs no bucketing or per-merchant thresholds. This
 * function answers a *separate* question the count cannot -- can the SKU still
 * be fulfilled? -- so a deleted product with huge demand keeps BOTH its count
 * AND a DELETED flag instead of collapsing into one mutually-exclusive tier.
 *
 * @param {boolean} inStock - available-to-sell now
 * @param {boolean} productExists - product still resolvable in the catalog
 * @returns {string} one of DELETED | OUT_OF_STOCK | IN_STOCK
 */
function catalogStatus(inStock, productExists) {
    if (!productExists) { return 'DELETED'; }   // offline/deleted since signup -> needs review
    return inStock ? 'IN_STOCK' : 'OUT_OF_STOCK';
}

// Tie-break weight only: when two SKUs have equal demand, surface the one that
// needs attention first (data problem, then restock, then already-sellable).
var STATUS_RANK = { DELETED: 0, OUT_OF_STOCK: 1, IN_STOCK: 2 };

/**
 * Build the ranked demand report from all WaitlistSubscription rows.
 * @param {Object} [opts]
 * @param {number} [opts.threshold=1] - available-to-sell units to count as in-stock
 * @returns {Object} {rows: Array<Object>, totals: Object, generatedAt: Date}
 */
function build(opts) {
    var threshold = (opts && opts.threshold) || 1;

    var bySku = {}; // sku -> {waiting, notified, failed, total}
    var iterator = CustomObjectMgr.getAllCustomObjects(OBJECT_TYPE);
    try {
        while (iterator.hasNext()) {
            var row = iterator.next();
            var sku = row.custom.productID;
            if (!sku) { continue; }
            var bucket = bySku[sku] || (bySku[sku] = { waiting: 0, notified: 0, failed: 0, total: 0 });
            var status = row.custom.status;
            bucket.total++;
            if (status === 'PENDING') { bucket.waiting++; }
            else if (status === 'NOTIFIED') { bucket.notified++; }
            else if (status === 'FAILED') { bucket.failed++; }
        }
    } finally {
        iterator.close(); // ALWAYS close the SeekableIterator
    }

    var rows = [];
    var totals = { skus: 0, waiting: 0, notified: 0, failed: 0, subscriptions: 0, oosWithDemand: 0 };

    Object.keys(bySku).forEach(function (sku) {
        var counts = bySku[sku];
        var product = ProductMgr.getProduct(sku);
        var productExists = !!product;
        var name = productExists ? (product.name || sku) : sku;
        var inStock = false;
        if (productExists) {
            var am = product.getAvailabilityModel();
            inStock = Boolean(am && am.isInStock(threshold));
        }
        var state = catalogStatus(inStock, productExists);

        rows.push({
            sku: sku,
            productName: name,
            productExists: productExists,
            waiting: counts.waiting,
            notified: counts.notified,
            failed: counts.failed,
            total: counts.total,
            inStock: inStock,
            status: state
        });

        totals.skus++;
        totals.waiting += counts.waiting;
        totals.notified += counts.notified;
        totals.failed += counts.failed;
        totals.subscriptions += counts.total;
        if (!inStock && productExists && counts.waiting > 0) { totals.oosWithDemand++; }
    });

    // Merchandiser ranking: (1) raw demand -- the count is the priority, and it
    // is scale-agnostic; (2) catalog status as a tie-break so equal-demand SKUs
    // that need attention surface first; (3) SKU for reproducible ordering.
    rows.sort(function (a, b) {
        if (b.waiting !== a.waiting) { return b.waiting - a.waiting; }
        if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) { return STATUS_RANK[a.status] - STATUS_RANK[b.status]; }
        return a.sku < b.sku ? -1 : (a.sku > b.sku ? 1 : 0);
    });

    return { rows: rows, totals: totals, generatedAt: new Date() };
}

/**
 * Minimal RFC-4180 field quoting.
 * @param {*} value
 * @returns {string}
 */
function csv(value) {
    var s = String(value === null || value === undefined ? '' : value);
    if (/[",\n]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

/**
 * Render a built report as CSV text.
 * @param {Object} report - result of build()
 * @returns {string}
 */
function toCsv(report) {
    var lines = ['SKU,Product,Waiting,Notified,Failed,Status'];
    report.rows.forEach(function (r) {
        lines.push([
            csv(r.sku),
            csv(r.productName),
            r.waiting,
            r.notified,
            r.failed,
            r.status
        ].join(','));
    });
    return lines.join('\n') + '\n';
}

module.exports = {
    build: build,
    toCsv: toCsv,
    catalogStatus: catalogStatus
};
