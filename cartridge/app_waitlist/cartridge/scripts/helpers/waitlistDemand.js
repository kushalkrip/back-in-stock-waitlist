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
 * Restock-priority label for a SKU.
 * @param {Object} counts - {waiting, notified, failed, total}
 * @param {boolean} inStock - available-to-sell now
 * @param {boolean} productExists - product still resolvable in the catalog
 * @returns {string} one of HIGH | MEDIUM | LOW | REVIEW | IN_STOCK | NONE
 */
function priorityFor(counts, inStock, productExists) {
    if (!productExists) { return 'REVIEW'; }  // product offline/deleted since signup
    if (inStock) { return 'IN_STOCK'; }        // available now; notify job will drain the queue
    if (counts.waiting >= 10) { return 'HIGH'; }
    if (counts.waiting >= 3) { return 'MEDIUM'; }
    if (counts.waiting >= 1) { return 'LOW'; }
    return 'NONE';                             // only fulfilled/failed rows remain
}

// Sort weight: actionable restocks (out-of-stock with demand) float to the top.
var RANK = { HIGH: 0, MEDIUM: 1, LOW: 2, REVIEW: 3, IN_STOCK: 4, NONE: 5 };

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
        var priority = priorityFor(counts, inStock, productExists);

        rows.push({
            sku: sku,
            productName: name,
            productExists: productExists,
            waiting: counts.waiting,
            notified: counts.notified,
            failed: counts.failed,
            total: counts.total,
            inStock: inStock,
            priority: priority
        });

        totals.skus++;
        totals.waiting += counts.waiting;
        totals.notified += counts.notified;
        totals.failed += counts.failed;
        totals.subscriptions += counts.total;
        if (!inStock && productExists && counts.waiting > 0) { totals.oosWithDemand++; }
    });

    // Merchandiser ranking: (1) restock priority, (2) most still waiting,
    // (3) SKU as a stable tie-break so runs are reproducible.
    rows.sort(function (a, b) {
        if (RANK[a.priority] !== RANK[b.priority]) { return RANK[a.priority] - RANK[b.priority]; }
        if (b.waiting !== a.waiting) { return b.waiting - a.waiting; }
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
    var lines = ['SKU,Product,Waiting,Notified,Failed,InStock,Priority'];
    report.rows.forEach(function (r) {
        lines.push([
            csv(r.sku),
            csv(r.productName),
            r.waiting,
            r.notified,
            r.failed,
            r.inStock ? 'yes' : 'no',
            r.priority
        ].join(','));
    });
    return lines.join('\n') + '\n';
}

module.exports = {
    build: build,
    toCsv: toCsv,
    priorityFor: priorityFor
};
