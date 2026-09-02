'use strict';

/**
 * Unit tests for the post-login auto-resume hook (controllers/Account.js).
 *
 * Account.js extends base Account and appends a route:BeforeComplete listener to
 * BOTH Login and SubmitRegistration that completes a "Notify Me" intent a guest
 * expressed before authenticating. We fake the SFRA `server` (capturing appended
 * middlewares), invoke the middleware with an emitter `this`, then fire the
 * captured BeforeComplete callback to simulate the route finishing — exactly the
 * order the platform uses.
 */
var chai = require('chai');
var sinon = require('sinon');
var proxyquire = require('proxyquire').noCallThru();
var expect = chai.expect;

// A richer `server` mock than test/mocks/server.js: supports extend + append.
function makeServer() {
    var appended = {};
    return {
        extend: function () { /* superModule wiring — irrelevant to the hook logic */ },
        append: function (name, fn) { appended[name] = fn; },
        get: function () {},
        post: function () {},
        exports: function () { return {__appended: appended}; },
        __appended: appended
    };
}

function load() {
    var serverMock = makeServer();
    var subscribe = sinon.stub().returns({success: true, status: 'subscribed'});
    var error = sinon.stub();

    proxyquire('../../../cartridge/controllers/Account', {
        server: serverMock,
        'dw/system/Logger': {getLogger: function () { return {error: error, info: sinon.stub()}; }},
        '*/cartridge/scripts/helpers/waitlistSubscribe': {
            subscribe: function () { return subscribe.apply(null, arguments); }
        }
    });

    return {server: serverMock, subscribe: subscribe, error: error};
}

// Drive an appended middleware and then fire its route:BeforeComplete listener.
function runHook(middleware, req, res) {
    var emitter = {
        handlers: {},
        on: function (event, cb) { this.handlers[event] = cb; }
    };
    var next = sinon.stub();
    middleware.call(emitter, req, res, next);
    sinon.assert.calledOnce(next); // the hook must never swallow the chain
    if (emitter.handlers['route:BeforeComplete']) {
        emitter.handlers['route:BeforeComplete']();
    }
    return emitter;
}

function fakeReq(pendingSku) {
    var store = {};
    if (pendingSku !== undefined) { store.waitlistPendingSku = pendingSku; }
    return {
        locale: {id: 'en_US'},
        session: {
            privacyCache: {
                get: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
                set: function (k, v) { store[k] = v; },
                store: store
            }
        }
    };
}

// res whose viewData is the authenticated success payload the base route sets.
function fakeRes(viewData) {
    var vd = viewData || {};
    return {
        getViewData: function () { return vd; },
        setViewData: function (next) { vd = next; },
        currentViewData: function () { return vd; }
    };
}

describe('Account controller — post-login waitlist auto-resume', function () {
    it('appends a route hook to BOTH Login and SubmitRegistration', function () {
        var t = load();
        expect(t.server.__appended).to.have.property('Login');
        expect(t.server.__appended).to.have.property('SubmitRegistration');
    });

    it('subscribes the newly-authenticated shopper and marks the redirect (Login)', function () {
        var t = load();
        var req = fakeReq('SKU-1');
        var res = fakeRes({
            authenticatedCustomer: {profile: {email: 'shopper@example.com'}},
            redirectUrl: '/s/RefArch/cool-tee/SKU-1.html'
        });

        runHook(t.server.__appended.Login, req, res);

        sinon.assert.calledOnceWithExactly(t.subscribe, 'shopper@example.com', 'SKU-1', 'en_US');
        // The PDP is told to show the confirmed state with no network call.
        expect(res.getViewData().redirectUrl).to.equal('/s/RefArch/cool-tee/SKU-1.html?wlnotified=1');
        // One-shot: the pending intent is cleared.
        expect(req.session.privacyCache.get('waitlistPendingSku')).to.equal(null);
    });

    it('appends the marker with & when the redirect already has a query string', function () {
        var t = load();
        var res = fakeRes({
            authenticatedCustomer: {profile: {email: 'a@b.com'}},
            redirectUrl: '/s/RefArch/tee.html?lang=en_US'
        });
        runHook(t.server.__appended.SubmitRegistration, fakeReq('SKU-9'), res);
        expect(res.getViewData().redirectUrl).to.equal('/s/RefArch/tee.html?lang=en_US&wlnotified=1');
    });

    it('is a no-op when there is no pending intent', function () {
        var t = load();
        var res = fakeRes({authenticatedCustomer: {profile: {email: 'a@b.com'}}, redirectUrl: '/x'});
        runHook(t.server.__appended.Login, fakeReq(/* none */), res);
        sinon.assert.notCalled(t.subscribe);
        expect(res.getViewData().redirectUrl).to.equal('/x'); // untouched
    });

    it('leaves the pending intent in place when login did NOT succeed', function () {
        var t = load();
        // No authenticatedCustomer on viewData → treated as a failed attempt.
        var req = fakeReq('SKU-1');
        runHook(t.server.__appended.Login, req, fakeRes({}));
        sinon.assert.notCalled(t.subscribe);
        // Still pending, so the next successful login completes it.
        expect(req.session.privacyCache.get('waitlistPendingSku')).to.equal('SKU-1');
    });

    it('never lets a subscribe failure break the login response', function () {
        var t = load();
        t.subscribe.throws(new Error('db down'));
        var res = fakeRes({
            authenticatedCustomer: {profile: {email: 'a@b.com'}},
            redirectUrl: '/x'
        });

        expect(function () {
            runHook(t.server.__appended.Login, fakeReq('SKU-1'), res);
        }).to.not.throw();

        sinon.assert.called(t.error); // logged
        expect(res.getViewData().redirectUrl).to.equal('/x'); // no marker appended
    });
});
