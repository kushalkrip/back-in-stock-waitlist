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
 * Route: WaitList-Subscribe (POST)
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

module.exports = server.exports();
