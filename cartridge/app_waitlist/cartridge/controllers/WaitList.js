'use strict';

/**
 * SFRA PARITY (optional). The PWA build uses the Custom SCAPI endpoint in
 * rest-apis/waitlist. This controller is the server-rendered SFRA equivalent:
 * an identical custom-object write behind a login-required, CSRF-protected
 * route, returning JSON. Included so the solution demonstrably covers both
 * storefront stacks.
 *
 * REGISTERED-USERS-ONLY (see docs/HLD.md DECISIONS LOCKED #2): the route is
 * gated by `userLoggedIn.validateLoggedInAjax` and the email is taken from the
 * authenticated session (`req.currentCustomer.profile.email`), NEVER from the
 * request body. Only sku/locale are read from the form.
 *
 * Routes:
 *   WaitList-Subscribe (POST) — create the subscription
 *   WaitList-Status    (GET)  — is this shopper already subscribed for a SKU?
 */

var server = require('server');
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');
var userLoggedIn = require('*/cartridge/scripts/middleware/userLoggedIn');

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Transaction = require('dw/system/Transaction');
var Calendar = require('dw/util/Calendar');

var OBJECT_TYPE = 'WaitlistSubscription';

server.post(
    'Subscribe',
    server.middleware.https,
    userLoggedIn.validateLoggedInAjax,
    csrfProtection.validateAjaxRequest,
    function (req, res, next) {
        // Email is server-derived from the authenticated session, not the body.
        var email = ((req.currentCustomer.profile && req.currentCustomer.profile.email) || '')
            .trim()
            .toLowerCase();
        var sku = (req.form.sku || '').trim();
        var locale = req.locale.id;

        if (!email) {
            res.setStatusCode(401);
            res.json({success: false, error: 'no-account-email'});
            return next();
        }
        if (!sku) {
            res.setStatusCode(400);
            res.json({success: false, error: 'invalid-sku'});
            return next();
        }

        var key = require('*/cartridge/scripts/util/waitlistKey').make(email, sku);
        var alreadySubscribed = false;

        Transaction.wrap(function () {
            var existing = CustomObjectMgr.getCustomObject(OBJECT_TYPE, key);
            if (existing) {
                alreadySubscribed = true;
                return;
            }
            var co = CustomObjectMgr.createCustomObject(OBJECT_TYPE, key);
            co.custom.email = email;
            co.custom.productID = sku;
            co.custom.status = 'PENDING';
            co.custom.locale = locale;
            co.custom.createdAt = new Calendar().getTime();
            co.custom.attemptCount = 0;
        });

        res.json({success: true, status: alreadySubscribed ? 'already-subscribed' : 'subscribed'});
        return next();
    }
);

// Status read for an authoritative/cross-device account "my waitlist" view.
// Deliberately NOT called by the PDP on load — the write is idempotent, so the
// storefront uses a zero-latency local hint there instead (see docs/UI-DESIGN.md
// LOCKED #4). Kept because the read is cheap and useful off the hot path.
server.get(
    'Status',
    server.middleware.https,
    userLoggedIn.validateLoggedInAjax,
    function (req, res, next) {
        var email = ((req.currentCustomer.profile && req.currentCustomer.profile.email) || '')
            .trim()
            .toLowerCase();
        var sku = (req.querystring.sku || '').trim();

        if (!sku) {
            res.setStatusCode(400);
            res.json({success: false, error: 'invalid-sku'});
            return next();
        }
        // Logged-in route, but fail open if the profile somehow has no email.
        if (!email) {
            res.json({subscribed: false});
            return next();
        }

        var key = require('*/cartridge/scripts/util/waitlistKey').make(email, sku);
        var existing = CustomObjectMgr.getCustomObject(OBJECT_TYPE, key);
        res.json({subscribed: !!existing});
        return next();
    }
);

// Cache-safe CSRF token source for the PDP "Notify Me" button. The PDP itself
// is page-cached, so a token embedded in that HTML would be stale/shared across
// shoppers; instead the button fetches a fresh, session-bound token from this
// uncached, login-gated endpoint at click time, then POSTs it to Subscribe.
server.get(
    'Token',
    server.middleware.https,
    userLoggedIn.validateLoggedInAjax,
    csrfProtection.generateToken,
    function (req, res, next) {
        var csrf = res.getViewData().csrf || {};
        res.json({tokenName: csrf.tokenName || 'csrf_token', token: csrf.token});
        return next();
    }
);

module.exports = server.exports();
