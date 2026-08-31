'use strict';

/**
 * Unit tests for the SFRA parity controller (controllers/WaitList.js).
 *
 * WHY THIS EXISTS: the PWA path calls the custom SCAPI endpoint (needs SLAS).
 * This controller is the storefront-session equivalent — login + CSRF, NO SLAS
 * token — so it can be exercised end-to-end on any SFRA instance by a logged-in
 * shopper. These tests go one step further and verify the handler logic with NO
 * instance at all: the `server` framework, the SFRA middlewares, and every
 * `dw/*` class are stubbed via proxyquire, and we drive the captured route
 * handler directly with fake (req, res, next).
 *
 * The security-critical assertion (LOCKED #2) is covered explicitly: the email
 * is taken from the authenticated session profile and NEVER from the request
 * body/form — even when the request tries to smuggle one in.
 */
var chai = require('chai');
var sinon = require('sinon');
var proxyquire = require('proxyquire').noCallThru();
var expect = chai.expect;

var serverMock = require('../../mocks/server');

var OBJECT_TYPE = 'WaitlistSubscription';

// ── dw/* + middleware stubs ──────────────────────────────────────────────────
var getCustomObject;
var createCustomObject;
// The shared write path (scripts/helpers/waitlistSubscribe) is stubbed: these
// controller tests own the route wiring + email-derivation contract, while the
// dedupe/key/status-machine is exercised in the helper's own tests.
var subscribeStub;

// A pass-through SFRA middleware (login gate / CSRF) — records that it was wired.
function passThrough(req, res, next) {
    return next();
}
var userLoggedInStub = {validateLoggedInAjax: passThrough};
var csrfStub = {validateAjaxRequest: passThrough};

// Deterministic key stub so we can assert what the object was keyed on without
// pulling in dw/crypto. Mirrors the real `sha256(email|sku)` contract shape.
var waitlistKeyStub = {
    make: function make(email, sku) {
        return 'key(' + email + '|' + sku + ')';
    }
};

function loadController() {
    getCustomObject = sinon.stub();
    createCustomObject = sinon.stub();

    // A fake Custom Object whose `custom` bag we can inspect after a write.
    createCustomObject.callsFake(function () {
        return {custom: {}};
    });

    // Default: a brand-new subscription. Individual tests override the return.
    subscribeStub = sinon.stub().returns({success: true, status: 'subscribed'});

    return proxyquire('../../../cartridge/controllers/WaitList', {
        server: serverMock,
        '*/cartridge/scripts/middleware/csrf': csrfStub,
        '*/cartridge/scripts/middleware/userLoggedIn': userLoggedInStub,
        '*/cartridge/scripts/util/waitlistKey': waitlistKeyStub,
        '*/cartridge/scripts/helpers/waitlistSubscribe': {
            subscribe: function () { return subscribeStub.apply(null, arguments); }
        },
        'dw/web/URLUtils': {
            // Chainable stub mirroring URLUtils.url(...).relative().toString().
            url: function url() {
                var args = Array.prototype.slice.call(arguments);
                return {
                    relative: function relative() { return this; },
                    toString: function toString() { return '/' + args.join('/'); }
                };
            }
        },
        'dw/object/CustomObjectMgr': {
            getCustomObject: function () {
                return getCustomObject.apply(null, arguments);
            },
            createCustomObject: function () {
                return createCustomObject.apply(null, arguments);
            }
        },
        'dw/system/Transaction': {
            // Run the callback synchronously — the atomicity is a platform
            // concern, the logic under test is what runs inside.
            wrap: function wrap(cb) {
                return cb();
            }
        },
        'dw/util/Calendar': function Calendar() {
            this.getTime = function getTime() {
                return new Date('2026-01-01T00:00:00Z');
            };
        }
    });
}

// Build a fake response that records status + JSON body.
function fakeRes() {
    return {
        statusCode: 200,
        body: null,
        setStatusCode: function setStatusCode(code) {
            this.statusCode = code;
        },
        json: function json(obj) {
            this.body = obj;
        }
    };
}

function fakeReq(overrides) {
    return Object.assign(
        {
            currentCustomer: {profile: {email: 'Shopper@Example.com'}},
            form: {sku: 'SKU-1'},
            querystring: {sku: 'SKU-1'},
            locale: {id: 'en_US'}
        },
        overrides || {}
    );
}

describe('WaitList controller (SFRA parity route)', function () {
    var subscribe;
    var status;

    beforeEach(function () {
        loadController();
        subscribe = serverMock.__getHandler('Subscribe');
        status = serverMock.__getHandler('Status');
    });

    describe('route wiring', function () {
        it('gates Subscribe behind HTTPS + login + CSRF', function () {
            var chain = serverMock.__getChain('Subscribe');
            expect(chain).to.include(serverMock.middleware.https);
            expect(chain).to.include(userLoggedInStub.validateLoggedInAjax);
            expect(chain).to.include(csrfStub.validateAjaxRequest);
        });

        it('gates Status behind HTTPS + login', function () {
            var chain = serverMock.__getChain('Status');
            expect(chain).to.include(serverMock.middleware.https);
            expect(chain).to.include(userLoggedInStub.validateLoggedInAjax);
        });
    });

    describe('Subscribe (POST)', function () {
        it('delegates to the shared helper with the session email + form sku and returns subscribed', function () {
            var req = fakeReq();
            var res = fakeRes();
            var next = sinon.stub();

            subscribe(req, res, next);

            // Email is server-derived + LOWERCASED; sku/locale from the request.
            sinon.assert.calledOnceWithExactly(subscribeStub, 'shopper@example.com', 'SKU-1', 'en_US');
            expect(res.statusCode).to.equal(200);
            expect(res.body).to.deep.equal({success: true, status: 'subscribed'});
            sinon.assert.calledOnce(next);
        });

        it('passes through the helper\'s already-subscribed result (idempotent)', function () {
            subscribeStub.returns({success: true, status: 'already-subscribed'});
            var res = fakeRes();

            subscribe(fakeReq(), res, sinon.stub());

            expect(res.body).to.deep.equal({success: true, status: 'already-subscribed'});
        });

        it('NEVER trusts an email from the request — uses the session profile (LOCKED #2)', function () {
            // The request tries to smuggle in an attacker-controlled address.
            var req = fakeReq({form: {sku: 'SKU-1', email: 'attacker@evil.com'}});
            var res = fakeRes();

            subscribe(req, res, sinon.stub());

            // The helper only ever sees the session email, never the body one.
            sinon.assert.calledOnceWithExactly(subscribeStub, 'shopper@example.com', 'SKU-1', 'en_US');
        });

        it('maps the helper\'s invalid-sku error to 400', function () {
            subscribeStub.returns({success: false, error: 'invalid-sku'});
            var res = fakeRes();
            subscribe(fakeReq({form: {sku: '   '}}), res, sinon.stub());
            expect(res.statusCode).to.equal(400);
            expect(res.body).to.deep.equal({success: false, error: 'invalid-sku'});
        });

        it('maps the helper\'s no-account-email error to 401', function () {
            subscribeStub.returns({success: false, error: 'no-account-email'});
            var res = fakeRes();
            subscribe(fakeReq({currentCustomer: {profile: {email: ''}}}), res, sinon.stub());
            expect(res.statusCode).to.equal(401);
            expect(res.body).to.deep.equal({success: false, error: 'no-account-email'});
        });
    });

    describe('Status (GET)', function () {
        it('reports subscribed:true when a row exists', function () {
            getCustomObject.returns({custom: {}});
            var res = fakeRes();
            status(fakeReq(), res, sinon.stub());
            expect(res.body).to.deep.equal({subscribed: true});
        });

        it('reports subscribed:false when no row exists', function () {
            getCustomObject.returns(null);
            var res = fakeRes();
            status(fakeReq(), res, sinon.stub());
            expect(res.body).to.deep.equal({subscribed: false});
        });

        it('rejects a missing sku with 400', function () {
            var res = fakeRes();
            status(fakeReq({querystring: {}}), res, sinon.stub());
            expect(res.statusCode).to.equal(400);
            expect(res.body).to.deep.equal({success: false, error: 'invalid-sku'});
        });

        it('fails open (subscribed:false) if the session has no email', function () {
            var res = fakeRes();
            status(fakeReq({currentCustomer: {profile: {email: ''}}}), res, sinon.stub());
            expect(res.body).to.deep.equal({subscribed: false});
            sinon.assert.notCalled(getCustomObject);
        });
    });
});
