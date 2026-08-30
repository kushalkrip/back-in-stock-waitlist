'use strict';

/**
 * Custom SCAPI endpoint implementation for the Back-In-Stock Waitlist.
 *
 * POST /custom/waitlist/v1/organizations/{organizationId}/subscriptions?siteId=...
 * Body: { "sku": "variant-sku", "locale": "en_US" }   <-- NO email
 *
 * REGISTERED-USERS-ONLY (see docs/HLD.md DECISIONS LOCKED #2). The email is
 * NEVER accepted from the request body; it is derived server-side from the
 * authenticated shopper's profile. A guest token is rejected with 401. This
 * closes the arbitrary-email abuse vector (mass-subscribing strangers) and the
 * unverified-deliverability problem in one move.
 *
 * Custom-API handlers use the AMBIENT `request` / `response` globals
 * (dw.system.Request / dw.system.Response) -- NOT an (req, res) signature.
 * The exported function name must match the operationId in schema.yaml.
 */

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Transaction = require('dw/system/Transaction');
var RESTResponseMgr = require('dw/system/RESTResponseMgr');
var Calendar = require('dw/util/Calendar');
var Logger = require('dw/system/Logger');

var OBJECT_TYPE = 'WaitlistSubscription';

/**
 * Create (idempotently) a waitlist subscription for the authenticated shopper.
 */
exports.joinWaitlist = function () {
    // 1) Identity gate: registered shoppers only. The email comes from here,
    //    not from the request body, so an unauthenticated/guest token cannot
    //    subscribe anyone (itself or a stranger).
    var customer = request.session && request.session.customer;
    if (!customer || !customer.authenticated || !customer.registered || !customer.profile) {
        RESTResponseMgr.createError(401, 'guest-not-allowed',
            'Sign in to join the back-in-stock waitlist').render();
        return;
    }

    var email = (customer.profile.email || '').trim().toLowerCase();
    if (!email) {
        // Registered account with no email on profile — should not happen, but
        // fail closed rather than persist an unusable row.
        RESTResponseMgr.createError(401, 'no-account-email',
            'Your account has no email address on file').render();
        return;
    }

    // 2) Parse the (email-free) body.
    var body;
    try {
        body = JSON.parse(request.httpParameterMap.requestBodyAsString);
    } catch (e) {
        RESTResponseMgr.createError(400, 'invalid-json', 'Request body must be valid JSON').render();
        return;
    }

    var sku = (body.sku || '').trim();
    var locale = body.locale || request.locale;

    if (!sku) {
        RESTResponseMgr.createError(400, 'invalid-sku', 'A product SKU is required').render();
        return;
    }

    var key = require('*/cartridge/scripts/util/waitlistKey').make(email, sku);
    var alreadySubscribed = false;

    try {
        // Idempotent create: query-before-insert (the real dedupe guard) inside a
        // single transaction so concurrent signups can't interleave a double insert.
        Transaction.wrap(function () {
            var existing = CustomObjectMgr.getCustomObject(OBJECT_TYPE, key);
            if (existing) {
                alreadySubscribed = true;
                return;
            }
            var co = CustomObjectMgr.createCustomObject(OBJECT_TYPE, key);
            co.custom.email = email; // authenticated account email, resolved server-side
            co.custom.productID = sku; // VARIANT SKU -- inventory is resolved per-variant
            co.custom.status = 'PENDING';
            co.custom.locale = locale;
            co.custom.createdAt = new Calendar().getTime();
            co.custom.attemptCount = 0;
        });
    } catch (e) {
        Logger.getLogger('waitlist', 'subscribe').error('Failed to persist subscription: {0}', e.message);
        RESTResponseMgr.createError(500, 'persistence-error', 'Could not save subscription').render();
        return;
    }

    // Treat "already subscribed" as success-equivalent for the shopper (idempotent).
    RESTResponseMgr.createSuccess({
        status: alreadySubscribed ? 'already-subscribed' : 'subscribed',
        sku: sku
    }).render();
};

// Expose the operation on the shopper (SLAS-authenticated) surface. The handler
// itself enforces the registered-only rule above.
exports.joinWaitlist.public = true;
