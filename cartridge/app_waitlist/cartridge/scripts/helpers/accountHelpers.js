'use strict';

/**
 * app_waitlist override of app_storefront_base scripts/helpers/accountHelpers.
 *
 * Purpose: send a guest who clicked "Notify me when back in stock" BACK to the
 * product page after they log in (or register), instead of the account
 * dashboard. Base SFRA maps the `rurl` query param to a small fixed enum of safe
 * endpoints (config/oAuthRenentryRedirectEndpoints: 1=Account-Show,
 * 2=Checkout-Begin) precisely to prevent open redirects, so there is no built-in
 * "return to this PDP" option.
 *
 * We add one: WaitList-BeforeLogin stashes a return URL in the session
 * privacyCache under `waitlistReturnUrl`. That URL is built SERVER-SIDE from a
 * product SKU via URLUtils.url('Product-Show', ...), never taken from client
 * input, so it is always a same-site product URL — no open-redirect surface.
 * Here we simply prefer that stashed value when present (one-shot), and defer to
 * base behaviour otherwise. This override is consumed by Account-Login and
 * Account-SubmitRegistration, which both call getLoginRedirectURL.
 */

var base = module.superModule;

// Capture the base implementation BEFORE we build our export object, so our
// wrapper can delegate to it without recursing into itself.
var baseGetLoginRedirectURL = base.getLoginRedirectURL;

/**
 * @param {string} redirectUrl - rurl of the req.querystring
 * @param {dw.system.CustomerActiveData|Object} privacyCache - req.session.privacyCache
 * @param {boolean} newlyRegisteredUser - true when called after registration
 * @returns {string} a redirect url
 */
function getLoginRedirectURL(redirectUrl, privacyCache, newlyRegisteredUser) {
    var target = privacyCache && privacyCache.get('waitlistReturnUrl');
    if (target) {
        // One-shot: clear it so a later, unrelated login doesn't bounce back to
        // a stale product page.
        privacyCache.set('waitlistReturnUrl', null);
        return target;
    }
    return baseGetLoginRedirectURL(redirectUrl, privacyCache, newlyRegisteredUser);
}

// Re-export every base member unchanged, then override the single function.
var exportsObj = {};
Object.keys(base).forEach(function (key) {
    exportsObj[key] = base[key];
});
exportsObj.getLoginRedirectURL = getLoginRedirectURL;

module.exports = exportsObj;
