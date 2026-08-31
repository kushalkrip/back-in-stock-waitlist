'use strict';

/**
 * Single source of truth for creating a WaitlistSubscription. Used by BOTH the
 * WaitList-Subscribe controller (explicit click) and the post-login auto-resume
 * hook (Account.js), so the write path — dedupe, key, status machine — is
 * identical no matter how the shopper got here.
 *
 * The email is ALWAYS the caller's responsibility to derive from an
 * authenticated session; this helper never reads it from request input.
 */

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Transaction = require('dw/system/Transaction');
var Calendar = require('dw/util/Calendar');

var OBJECT_TYPE = 'WaitlistSubscription';

/**
 * Create (or detect an existing) waitlist subscription for an email + variant SKU.
 *
 * @param {string} email - server-derived, authenticated shopper email
 * @param {string} sku - resolved variant SKU
 * @param {string} locale - locale id to stamp on the row
 * @returns {Object} {success:true, status:'subscribed'|'already-subscribed'} or
 *                   {success:false, error:'no-account-email'|'invalid-sku'}
 */
function subscribe(email, sku, locale) {
    var cleanEmail = (email || '').trim().toLowerCase();
    var cleanSku = (sku || '').trim();

    if (!cleanEmail) { return { success: false, error: 'no-account-email' }; }
    if (!cleanSku) { return { success: false, error: 'invalid-sku' }; }

    var key = require('*/cartridge/scripts/util/waitlistKey').make(cleanEmail, cleanSku);
    var alreadySubscribed = false;

    Transaction.wrap(function () {
        var existing = CustomObjectMgr.getCustomObject(OBJECT_TYPE, key);
        if (existing) {
            alreadySubscribed = true;
            return;
        }
        var co = CustomObjectMgr.createCustomObject(OBJECT_TYPE, key);
        co.custom.email = cleanEmail;
        co.custom.productID = cleanSku;
        co.custom.status = 'PENDING';
        co.custom.locale = locale;
        co.custom.createdAt = new Calendar().getTime();
        co.custom.attemptCount = 0;
    });

    return { success: true, status: alreadySubscribed ? 'already-subscribed' : 'subscribed' };
}

module.exports = { subscribe: subscribe };
