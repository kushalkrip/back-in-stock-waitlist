'use strict';

/**
 * DEMO-ONLY job step: programmatically move the SKUs that shoppers are waiting
 * on in/out of stock, so the full back-in-stock lifecycle can be exercised on a
 * sandbox without Business Manager inventory clicks or admin OCAPI access.
 *
 * It does NOT create inventory records (the script API cannot) -- it updates
 * the allocation on records that already exist in the CURRENT SITE's inventory
 * list. Run it under the same site context as the notify step so the
 * availability it writes is the availability the notify step reads.
 *
 * Params:
 *   Restock  (boolean, default true)  true  -> set allocation to SeedQty (in stock)
 *                                     false -> set allocation to 0 (reset to OOS)
 *   SeedQty  (long,    default 100)   allocation to write when restocking
 *   SeedLimit(long,    default 0)     cap on how many distinct SKUs to touch
 *                                     (0 = all). Use to leave a WAITING remainder.
 *   Skus     (string,  optional)      explicit comma-separated SKU list; when set
 *                                     it overrides the PENDING-derived list.
 *
 * This is intentionally NOT wired into the recurring job -- it is a manual demo
 * lever. Real restocks come from feeds / BM edits; the notify step is agnostic
 * to how availability changed.
 */

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var ProductInventoryMgr = require('dw/catalog/ProductInventoryMgr');
var Transaction = require('dw/system/Transaction');
var Status = require('dw/system/Status');
var Logger = require('dw/system/Logger');

var OBJECT_TYPE = 'WaitlistSubscription';

/** Collect the distinct SKUs shoppers are currently PENDING on. */
function pendingSkus(limit) {
    var seen = {};
    var out = [];
    var it = CustomObjectMgr.queryCustomObjects(OBJECT_TYPE, 'custom.status = {0}', 'custom.productID asc', 'PENDING');
    try {
        while (it.hasNext()) {
            var sku = it.next().custom.productID;
            if (sku && !Object.prototype.hasOwnProperty.call(seen, sku)) {
                seen[sku] = true;
                out.push(sku);
                if (limit > 0 && out.length >= limit) { break; }
            }
        }
    } finally {
        it.close();
    }
    return out;
}

exports.execute = function (params) {
    var log = Logger.getLogger('waitlist', 'seed');
    var restock = !(params && params.Restock === false);
    var qty = (params && params.SeedQty) ? params.SeedQty : 100;
    var limit = (params && params.SeedLimit) ? params.SeedLimit : 0;

    var list = ProductInventoryMgr.getInventoryList();
    if (!list) {
        return new Status(Status.ERROR, 'NO_LIST',
            'No inventory list assigned to the current site; cannot seed stock.');
    }

    var skus;
    if (params && params.Skus) {
        skus = params.Skus.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    } else {
        skus = pendingSkus(limit);
    }

    var updated = 0;
    var missing = 0;
    var target = restock ? qty : 0;
    // setAllocation(Number) was removed in API 21.7; only the (quantity, resetDate)
    // overload remains. Reset "as of now" so ATS == allocation with no prior orders
    // counted against it.
    var resetDate = new Date();

    for (var i = 0; i < skus.length; i++) {
        var sku = skus[i];
        var record = list.getRecord(sku);
        if (!record) {
            missing++;
            log.warn('No inventory record for {0} in list {1}; skipped.', sku, list.ID);
            continue;
        }
        // eslint-disable-next-line no-loop-func
        Transaction.wrap(function () {
            record.setAllocation(target, resetDate);
            record.setPerpetual(false);
        });
        updated++;
    }

    var msg = (restock ? 'Restocked ' : 'Zeroed ') + updated + ' SKU(s) to allocation ' + target +
        ' in list ' + list.ID + '; ' + missing + ' had no record.';
    log.info(msg);
    return new Status(Status.OK, 'OK', msg);
};
