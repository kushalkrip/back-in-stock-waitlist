'use strict';

/**
 * Chunk-oriented job step: walk PENDING waitlist rows, check variant-level
 * inventory, notify replenished SKUs via the outbound service, and flip each
 * row's status idempotently.
 *
 * Chunk steps have exactly these lifecycle hooks (there is NO beforeRead /
 * afterProcess / etc.): beforeStep, getTotalCount, read, process, write,
 * beforeChunk, afterChunk, afterStep.
 *
 *   read()    -> one PENDING row at a time (undefined ends the read loop)
 *   process() -> resolve variant inventory; return an item to notify, or
 *                undefined to skip (row stays PENDING)
 *   write()   -> called once per chunk with the array of processed items;
 *                calls the service and commits status per row
 */

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var ProductMgr = require('dw/catalog/ProductMgr');
var Transaction = require('dw/system/Transaction');
var Calendar = require('dw/util/Calendar');
var Status = require('dw/system/Status');
var Logger = require('dw/system/Logger');

var svc = require('*/cartridge/scripts/services/waitlistNotifyService');

var OBJECT_TYPE = 'WaitlistSubscription';
var MAX_ATTEMPTS = 5;

var iterator;
var threshold;
var sawTransientFailure;
var skuCache; // step-scoped Map<sku, inStock>: one inventory check per distinct SKU

/**
 * @param {Object} params - step parameters from BM (NotifyThreshold).
 */
exports.beforeStep = function (params) {
    // Notify only when available-to-sell >= threshold. Guards against blasting
    // a thousand shoppers on a 1-unit restock that instantly resells out.
    threshold = params && params.NotifyThreshold ? params.NotifyThreshold : 1;
    sawTransientFailure = false;

    // Step-scoped availability cache. Thrown away in afterStep -- deliberately
    // NOT persisted, so we never notify on stale intra-run inventory.
    skuCache = {};

    // Dual-purpose sort (docs/HLD.md DECISIONS LOCKED #4 + §5):
    //   productID asc -> all rows for one SKU arrive consecutively, so the
    //                    availability check fires ONCE per distinct waiting SKU
    //                    (O(distinct SKUs), not O(rows)) via skuCache below.
    //   createdAt asc -> within each SKU, oldest-first for fair FIFO fulfillment
    //                    under partial replenishment.
    iterator = CustomObjectMgr.queryCustomObjects(
        OBJECT_TYPE,
        'custom.status = {0}',
        'custom.productID asc, custom.createdAt asc',
        'PENDING'
    );
};

exports.getTotalCount = function () {
    return iterator ? iterator.count : 0;
};

exports.read = function () {
    if (iterator && iterator.hasNext()) {
        return iterator.next();
    }
    return undefined; // ends the read loop
};

/**
 * Variant-level inventory resolution happens HERE.
 * @param {dw.object.CustomObject} row
 * @returns {Object|undefined} item to notify, or undefined to skip
 */
exports.process = function (row) {
    var sku = row.custom.productID;
    var product = ProductMgr.getProduct(sku);

    if (!product) {
        // Orphaned SKU (product deleted/offline after signup). Age it out so it
        // doesn't linger PENDING forever.
        if ((row.custom.attemptCount || 0) >= MAX_ATTEMPTS) {
            return { row: row, expire: true };
        }
        return undefined;
    }

    // SKU-cache dedup: the expensive availability lookup runs once per distinct
    // SKU, not once per row. Because the query is sorted productID asc, a burst
    // of rows for the same SKU reuses the first row's decision. 100k PENDING
    // rows over 2k out-of-stock SKUs => 2k checks, not 100k.
    var inStock;
    if (Object.prototype.hasOwnProperty.call(skuCache, sku)) {
        inStock = skuCache[sku];
    } else {
        var availability = product.getAvailabilityModel();
        inStock = Boolean(availability && availability.isInStock(threshold));
        skuCache[sku] = inStock;
    }
    if (!inStock) {
        return undefined; // still OOS -> skip, row stays PENDING
    }

    return {
        row: row,
        expire: false,
        email: row.custom.email,
        sku: product.ID,
        productName: product.name,
        locale: row.custom.locale
    };
};

/**
 * @param {dw.util.List} items - processed items for this chunk
 */
exports.write = function (items) {
    for (var i = 0; i < items.length; i++) {
        var item = items[i];

        if (item.expire) {
            Transaction.wrap(function () { // eslint-disable-line no-loop-func
                item.row.custom.status = 'FAILED';
            });
            continue;
        }

        var result = svc.call({
            email: item.email,
            sku: item.sku,
            productName: item.productName,
            locale: item.locale
        });

        Transaction.wrap(function () { // eslint-disable-line no-loop-func
            item.row.custom.attemptCount = (item.row.custom.attemptCount || 0) + 1;

            if (result.isOk()) {
                item.row.custom.status = 'NOTIFIED';
                item.row.custom.notifiedAt = new Calendar().getTime();
                return;
            }

            // Transient (rate-limited / circuit-broken / timeout) -> keep PENDING
            // so the next run retries. Hard errors -> FAILED (or expire on retries).
            var reason = result.getUnavailableReason && result.getUnavailableReason();
            if (reason) {
                sawTransientFailure = true;
                Logger.getLogger('waitlist', 'notify').warn(
                    'Transient notify failure for sku {0}, reason {1}; staying PENDING',
                    item.sku, reason);
            } else if (item.row.custom.attemptCount >= MAX_ATTEMPTS) {
                item.row.custom.status = 'FAILED';
            }
            // else: leave PENDING for a retry
        });
    }
};

/**
 * @param {boolean} success - whether the step's own execution succeeded
 * @returns {dw.system.Status}
 */
exports.afterStep = function (success) {
    if (iterator) {
        iterator.close(); // ALWAYS close the SeekableIterator
        iterator = null;
    }
    skuCache = null; // release the run-scoped availability cache

    if (sawTransientFailure) {
        return new Status(Status.OK, 'FINISHED_WITH_WARNINGS',
            'Some notifications deferred; will retry next run.');
    }
    return new Status(Status.OK);
};
