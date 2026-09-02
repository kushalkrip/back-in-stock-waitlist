'use strict';

/**
 * Back-In-Stock "Notify Me" behaviour for the SFRA PDP.
 *
 * This module is bundled (see app_waitlist/webpack.config.js) to
 * static/default/js/waitlist.js and loaded via assets.addJs('/js/waitlist.js')
 * from the app_waitlist override of product/components/addToCartProduct.isml.
 * It replaces the former inline <script> that lived in a full-page override of
 * productDetails.isml. Benefits: CSP-safe (no inline script), unit-testable
 * (the decision logic is exported as pure functions), and localisable (every
 * user-visible string is rendered server-side via Resource.msg and read from
 * data-* attributes -- this file contains no hardcoded copy).
 *
 * The block is cache-safe: it embeds NO CSRF token (the PDP is page-cacheable).
 * At click time it fetches a fresh, session-bound token from the login-gated
 * WaitList-Token endpoint, then POSTs it to WaitList-Subscribe. A guest is sent
 * to WaitList-BeforeLogin (which stashes this PDP as the post-login return
 * target, server-side, so there is no open-redirect surface).
 */

var SELECTORS = {
    block: '[data-waitlist-block]',
    atc: '[data-waitlist-atc]',
    button: '.js-waitlist-notify',
    msg: '.waitlist-notify-msg'
};

/**
 * Should the Notify Me block be shown for this SFRA product model? True only
 * when the shopper has resolved a concrete, orderable-but-unavailable unit:
 * readyToOrder (all variation attrs chosen) AND NOT available AND not a
 * set/bundle. Mirrors the PWA rule in docs/UI-DESIGN.md.
 * @param {Object} product - SFRA product model (from the ajax variation response)
 * @returns {boolean}
 */
function shouldShowNotify(product) {
    if (!product) { return false; }
    var type = product.productType;
    return !!product.readyToOrder && product.available === false
        && type !== 'set' && type !== 'bundle';
}

/**
 * Build the form-encoded body for WaitList-Subscribe.
 * @param {string} sku
 * @param {string} tokenName - CSRF token field name (defaults to csrf_token)
 * @param {string} token - CSRF token value
 * @returns {string}
 */
function buildSubscribeBody(sku, tokenName, token) {
    return 'sku=' + encodeURIComponent(sku) + '&'
        + encodeURIComponent(tokenName || 'csrf_token') + '=' + encodeURIComponent(token);
}

/**
 * Strip a leading or embedded `wlnotified=1` marker from a location.search,
 * keeping the rest of the query string well-formed.
 * @param {string} search - e.g. "?wlnotified=1&foo=bar"
 * @returns {string}
 */
function stripWlNotified(search) {
    return (search || '').replace(/([?&])wlnotified=1(&|$)/, function (match, p1, p2) {
        if (p1 === '?' && p2 === '&') { return '?'; }
        return p2 === '&' ? p1 : '';
    });
}

/**
 * Read the localised strings the server rendered onto the block.
 * @param {Element} block
 * @returns {Object}
 */
function readStrings(block) {
    return {
        cta: block.getAttribute('data-msg-cta'),
        onList: block.getAttribute('data-msg-onlist'),
        already: block.getAttribute('data-msg-already'),
        done: block.getAttribute('data-msg-done'),
        alreadyMsg: block.getAttribute('data-msg-alreadymsg'),
        error: block.getAttribute('data-msg-error'),
        netError: block.getAttribute('data-msg-neterror')
    };
}

/**
 * Wire up the Notify Me block. Safe to call once per PDP; a no-op if the block
 * is not present. Initial visibility is server-rendered (see the .isml), so
 * this only handles clicks, live variant reactivity, and the post-login
 * confirmation.
 * @param {Document} [doc]
 */
function init(doc) {
    var d = doc || document;
    var block = d.querySelector(SELECTORS.block);
    if (!block) { return; }
    var btn = block.querySelector(SELECTORS.button);
    if (!btn) { return; }
    var msgEl = block.querySelector(SELECTORS.msg);
    var atc = d.querySelector(SELECTORS.atc);
    var S = readStrings(block);

    // Idempotent: the bundle can be loaded more than once on a page (the base
    // SFRA PDP itself emits its script assets twice on this storefront), so
    // guard the whole wiring -- clicks, the jQuery variant handler, and the
    // post-login confirmation -- against binding twice.
    if (block.getAttribute('data-wl-init')) { return; }
    block.setAttribute('data-wl-init', '1');

    function setMsg(text) { if (msgEl) { msgEl.textContent = text || ''; } }
    function setVisible(show) {
        block.classList.toggle('d-none', !show);
        if (atc) { atc.classList.toggle('d-none', show); }
    }
    function resetButton() { btn.disabled = false; btn.textContent = S.cta; setMsg(''); }

    function toLogin() {
        var beforeUrl = block.getAttribute('data-before-login-url');
        var sku = block.getAttribute('data-sku');
        if (beforeUrl) {
            window.location.href = beforeUrl
                + (beforeUrl.indexOf('?') === -1 ? '?' : '&')
                + 'sku=' + encodeURIComponent(sku);
        } else {
            window.location.href = block.getAttribute('data-login-url');
        }
    }

    function parse(response) {
        return response.json()
            .catch(function () { return {}; })
            .then(function (json) { return { status: response.status, json: json }; });
    }

    function subscribe() {
        btn.disabled = true;
        var sku = block.getAttribute('data-sku');
        fetch(block.getAttribute('data-token-url'), {
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        }).then(parse).then(function (res) {
            if (res.status === 401 || res.json.loggedin === false || !res.json.token) {
                toLogin();
                return null;
            }
            return fetch(block.getAttribute('data-subscribe-url'), {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: buildSubscribeBody(sku, res.json.tokenName, res.json.token)
            }).then(parse);
        }).then(function (res) {
            if (!res) { return; }
            var json = res.json || {};
            if (res.status === 401 || json.loggedin === false) { toLogin(); return; }
            if (json.success) {
                var already = json.status === 'already-subscribed';
                btn.textContent = already ? S.already : S.onList;
                setMsg(already ? S.alreadyMsg : S.done);
            } else {
                setMsg(S.error);
                btn.disabled = false;
            }
        }).catch(function () {
            setMsg(S.netError);
            btn.disabled = false;
        });
    }

    if (!btn.getAttribute('data-bound')) {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', subscribe);
    }

    // Live reactivity: SFRA fires the jQuery custom event
    // `product:afterAttributeSelect` on variant change. Native addEventListener
    // won't receive jQuery-triggered events, so bind through jQuery once the
    // footer bundle that provides it has loaded.
    (function attach() {
        if (!window.jQuery) { window.setTimeout(attach, 120); return; }
        window.jQuery('body').on('product:afterAttributeSelect', function (event, response) {
            var product = response && response.data && response.data.product;
            if (!product) { return; }
            var show = shouldShowNotify(product);
            setVisible(show);
            if (show && product.id && product.id !== block.getAttribute('data-sku')) {
                // New OOS variant selected -- retarget and reset the button.
                block.setAttribute('data-sku', product.id);
                resetButton();
            }
        });
    }());

    // Post-login confirmation (zero network). A guest who clicked Notify Me was
    // auto-subscribed server-side during login (see Account.js) and lands back
    // here with ?wlnotified=1; reflect the confirmed state immediately, then
    // strip the marker so a refresh/share is clean.
    if (/[?&]wlnotified=1(&|$)/.test(window.location.search)) {
        btn.disabled = true;
        btn.textContent = S.onList;
        setMsg(S.done);
        if (window.history && window.history.replaceState) {
            var clean = window.location.pathname
                + stripWlNotified(window.location.search)
                + window.location.hash;
            window.history.replaceState(null, '', clean);
        }
    }
}

module.exports = {
    init: init,
    shouldShowNotify: shouldShowNotify,
    buildSubscribeBody: buildSubscribeBody,
    stripWlNotified: stripWlNotified
};
