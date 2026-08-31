'use strict';

/**
 * app_waitlist extension of app_storefront_base controllers/Account.
 *
 * Purpose: complete the "Notify Me" intent a guest expressed BEFORE they logged
 * in, so they never have to click the button a second time after authenticating.
 *
 * Flow: guest clicks Notify Me on an OOS PDP -> WaitList-BeforeLogin stashes the
 * product SKU in the session (privacyCache 'waitlistPendingSku') -> shopper logs
 * in or registers. Here we hook the tail of Account-Login and
 * Account-SubmitRegistration and, if that pending intent exists, write the
 * subscription SERVER-SIDE using the now-authenticated email. No extra
 * round-trip, no re-click, no added latency — the row is created inside the same
 * login request, before the PDP re-renders.
 *
 * We register a route:BeforeComplete listener (rather than acting inline) for two
 * reasons:
 *   1. Base Account-SubmitRegistration defers the actual customer create+login
 *      into its OWN route:BeforeComplete. Ours is registered after base's, so it
 *      fires after the customer exists.
 *   2. Both routes place the authenticated customer at
 *      res.viewData.authenticatedCustomer and the post-login target at
 *      res.viewData.redirectUrl on success — the authoritative, race-free source
 *      for the email and the return URL (req.currentCustomer is the pre-login
 *      guest and would be stale here).
 */

var server = require('server');
server.extend(module.superModule);

var Logger = require('dw/system/Logger');
var subscribeHelper = require('*/cartridge/scripts/helpers/waitlistSubscribe');

/**
 * Consume a pending "Notify Me" intent and create the subscription. Safe to call
 * on every login; a no-op unless a pending SKU was stashed by WaitList-BeforeLogin
 * AND the login/registration succeeded.
 *
 * @param {Object} req - SFRA request
 * @param {Object} res - SFRA response (post-success viewData already populated)
 */
function resumePendingWaitlist(req, res) {
    var pendingSku = req.session.privacyCache.get('waitlistPendingSku');
    if (!pendingSku) { return; }

    var viewData = res.getViewData();
    // Both routes place the authenticated dw.customer.Customer here on success.
    var authenticatedCustomer = viewData && viewData.authenticatedCustomer;
    var profile = authenticatedCustomer && authenticatedCustomer.profile;

    // Only proceed on a genuine success (authenticated customer present). On a
    // failed attempt we intentionally leave the pending SKU in place so the next
    // successful login still completes the subscription.
    if (!profile || !profile.email) { return; }

    // One-shot: clear so an unrelated later login doesn't re-subscribe.
    req.session.privacyCache.set('waitlistPendingSku', null);

    try {
        var result = subscribeHelper.subscribe(profile.email, pendingSku, req.locale.id);
        if (result && result.success && viewData.redirectUrl) {
            // Tell the PDP it can show the confirmed state with NO network call.
            viewData.redirectUrl += (viewData.redirectUrl.indexOf('?') === -1 ? '?' : '&') + 'wlnotified=1';
            res.setViewData(viewData);
        }
    } catch (e) {
        // Never let a waitlist write break the login response.
        Logger.getLogger('waitlist', 'waitlist').error('Auto-subscribe after login failed: {0}', e.message);
    }
}

server.append('Login', function (req, res, next) {
    this.on('route:BeforeComplete', function () {
        resumePendingWaitlist(req, res);
    });
    return next();
});

server.append('SubmitRegistration', function (req, res, next) {
    this.on('route:BeforeComplete', function () {
        resumePendingWaitlist(req, res);
    });
    return next();
});

module.exports = server.exports();
