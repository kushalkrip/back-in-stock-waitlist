'use strict';

/**
 * Unit tests for the custom SCAPI endpoint (rest-apis/waitlist/script.js).
 *
 * Custom-API handlers use the AMBIENT `request` global and render via
 * RESTResponseMgr rather than an (req, res) signature, so we set `global.request`
 * per test and stub RESTResponseMgr to capture the status code / error id / body
 * that would be rendered. The security contract is the headline assertion: the
 * email is derived from the authenticated session and a body-supplied email is
 * ignored; a guest token can subscribe no one.
 */
var chai = require('chai');
var sinon = require('sinon');
var proxyquire = require('proxyquire').noCallThru();
var expect = chai.expect;

var FIXED_TIME = new Date('2026-03-03T00:00:00Z');

function load(overrides) {
    overrides = overrides || {};
    var getCustomObject = sinon.stub();
    var created = {custom: {}};
    var createCustomObject = sinon.stub().returns(created);

    // Capture the last rendered response.
    var rendered = {};
    function capture(kind) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            return {
                render: function () {
                    rendered.kind = kind;
                    rendered.args = args;
                }
            };
        };
    }

    var transactionWrap = overrides.transactionThrows
        ? function () { throw new Error('boom'); }
        : function (cb) { return cb(); };

    var mod = proxyquire('../../../cartridge/rest-apis/waitlist/script', {
        'dw/object/CustomObjectMgr': {
            getCustomObject: function () { return getCustomObject.apply(null, arguments); },
            createCustomObject: function () { return createCustomObject.apply(null, arguments); }
        },
        'dw/system/Transaction': {wrap: transactionWrap},
        'dw/system/RESTResponseMgr': {
            createError: capture('error'),
            createSuccess: capture('success')
        },
        'dw/util/Calendar': function Calendar() { this.getTime = function () { return FIXED_TIME; }; },
        'dw/system/Logger': {getLogger: function () { return {error: sinon.stub(), info: sinon.stub()}; }},
        '*/cartridge/scripts/util/waitlistKey': {
            make: function (email, sku) { return 'key(' + email + '|' + sku + ')'; }
        }
    });

    return {mod: mod, getCustomObject: getCustomObject, createCustomObject: createCustomObject, created: created, rendered: rendered};
}

// Build the ambient `request` global.
function setRequest(opts) {
    opts = opts || {};
    global.request = {
        locale: opts.locale || 'en_US',
        session: {
            customer: opts.customer === null ? null : Object.assign({
                authenticated: true,
                registered: true,
                profile: {email: 'Shopper@Example.com'}
            }, opts.customer || {})
        },
        httpParameterMap: {
            requestBodyAsString: 'body' in opts ? opts.body : JSON.stringify({sku: 'SKU-1', locale: 'en_US'}),
            get: function (name) {
                return {stringValue: (opts.params && opts.params[name]) || null};
            }
        }
    };
}

describe('SCAPI waitlist endpoint', function () {
    afterEach(function () { delete global.request; });

    describe('joinWaitlist (POST)', function () {
        it('creates a PENDING subscription for a registered shopper and renders subscribed', function () {
            var t = load();
            t.getCustomObject.returns(null);
            setRequest({});

            t.mod.joinWaitlist();

            expect(t.rendered.kind).to.equal('success');
            expect(t.rendered.args[0]).to.deep.equal({status: 'subscribed', sku: 'SKU-1'});
            // Email is the LOWERCASED session email; sku from the body.
            expect(t.created.custom.email).to.equal('shopper@example.com');
            expect(t.created.custom.productID).to.equal('SKU-1');
            expect(t.created.custom.status).to.equal('PENDING');
            expect(t.created.custom.attemptCount).to.equal(0);
        });

        it('is idempotent: an existing row renders already-subscribed with no insert', function () {
            var t = load();
            t.getCustomObject.returns({custom: {}});
            setRequest({});

            t.mod.joinWaitlist();

            expect(t.rendered.args[0]).to.deep.equal({status: 'already-subscribed', sku: 'SKU-1'});
            sinon.assert.notCalled(t.createCustomObject);
        });

        it('NEVER trusts a body-supplied email — uses the session profile (LOCKED #2)', function () {
            var t = load();
            t.getCustomObject.returns(null);
            setRequest({body: JSON.stringify({sku: 'SKU-1', email: 'attacker@evil.com'})});

            t.mod.joinWaitlist();

            expect(t.created.custom.email).to.equal('shopper@example.com'); // never attacker@evil.com
        });

        it('rejects a guest token with 401 guest-not-allowed', function () {
            var t = load();
            setRequest({customer: {authenticated: true, registered: false}});
            t.mod.joinWaitlist();
            expect(t.rendered.kind).to.equal('error');
            expect(t.rendered.args[0]).to.equal(401);
            expect(t.rendered.args[1]).to.equal('guest-not-allowed');
            sinon.assert.notCalled(t.createCustomObject);
        });

        it('rejects a registered account with no email (401 no-account-email)', function () {
            var t = load();
            setRequest({customer: {profile: {email: ''}}});
            t.mod.joinWaitlist();
            expect(t.rendered.args[0]).to.equal(401);
            expect(t.rendered.args[1]).to.equal('no-account-email');
        });

        it('rejects an unparseable body with 400 invalid-json', function () {
            var t = load();
            setRequest({body: 'not json{'});
            t.mod.joinWaitlist();
            expect(t.rendered.args[0]).to.equal(400);
            expect(t.rendered.args[1]).to.equal('invalid-json');
        });

        it('rejects a missing sku with 400 invalid-sku', function () {
            var t = load();
            setRequest({body: JSON.stringify({locale: 'en_US'})});
            t.mod.joinWaitlist();
            expect(t.rendered.args[0]).to.equal(400);
            expect(t.rendered.args[1]).to.equal('invalid-sku');
        });

        it('maps a persistence failure to 500 persistence-error', function () {
            var t = load({transactionThrows: true});
            setRequest({});
            t.mod.joinWaitlist();
            expect(t.rendered.args[0]).to.equal(500);
            expect(t.rendered.args[1]).to.equal('persistence-error');
        });

        it('is exposed on the shopper (SLAS) surface', function () {
            var t = load();
            expect(t.mod.joinWaitlist.public).to.equal(true);
        });
    });

    describe('getWaitlistStatus (GET)', function () {
        it('reports subscribed:true when a row exists for the authenticated shopper', function () {
            var t = load();
            t.getCustomObject.returns({custom: {}});
            setRequest({params: {c_sku: 'SKU-1'}});
            t.mod.getWaitlistStatus();
            expect(t.rendered.kind).to.equal('success');
            expect(t.rendered.args[0]).to.deep.equal({subscribed: true, sku: 'SKU-1'});
        });

        it('reports subscribed:false when no row exists', function () {
            var t = load();
            t.getCustomObject.returns(null);
            setRequest({params: {c_sku: 'SKU-1'}});
            t.mod.getWaitlistStatus();
            expect(t.rendered.args[0]).to.deep.equal({subscribed: false, sku: 'SKU-1'});
        });

        it('rejects a missing c_sku with 400', function () {
            var t = load();
            setRequest({params: {}});
            t.mod.getWaitlistStatus();
            expect(t.rendered.kind).to.equal('error');
            expect(t.rendered.args[0]).to.equal(400);
        });

        it('fails OPEN for a guest (200 subscribed:false, no lookup, no info leak)', function () {
            var t = load();
            setRequest({customer: {authenticated: false, registered: false, profile: null}, params: {c_sku: 'SKU-1'}});
            t.mod.getWaitlistStatus();
            expect(t.rendered.kind).to.equal('success');
            expect(t.rendered.args[0]).to.deep.equal({subscribed: false, sku: 'SKU-1'});
            sinon.assert.notCalled(t.getCustomObject);
        });
    });
});
