'use strict';

/**
 * Unit tests for the shared write path (scripts/helpers/waitlistSubscribe.js).
 *
 * This is the SINGLE source of truth for creating a WaitlistSubscription, reused
 * by both the WaitList-Subscribe controller and the post-login auto-resume hook.
 * The controller tests stub this helper away, so its own dedupe / key /
 * status-machine / row-shape contract is pinned down here with dw/* stubbed.
 */
var chai = require('chai');
var sinon = require('sinon');
var proxyquire = require('proxyquire').noCallThru();
var expect = chai.expect;

var FIXED_TIME = new Date('2026-01-01T00:00:00Z');

function load() {
    var getCustomObject = sinon.stub();
    var created = {custom: {}};
    var createCustomObject = sinon.stub().returns(created);

    var keyMake = sinon.stub().callsFake(function (email, sku) {
        return 'key(' + email + '|' + sku + ')';
    });

    var mod = proxyquire('../../../cartridge/scripts/helpers/waitlistSubscribe', {
        'dw/object/CustomObjectMgr': {
            getCustomObject: function () { return getCustomObject.apply(null, arguments); },
            createCustomObject: function () { return createCustomObject.apply(null, arguments); }
        },
        'dw/system/Transaction': {
            wrap: function wrap(cb) { return cb(); } // synchronous; atomicity is a platform concern
        },
        'dw/util/Calendar': function Calendar() {
            this.getTime = function getTime() { return FIXED_TIME; };
        },
        '*/cartridge/scripts/util/waitlistKey': {make: keyMake}
    });

    return {
        mod: mod,
        getCustomObject: getCustomObject,
        createCustomObject: createCustomObject,
        created: created,
        keyMake: keyMake
    };
}

describe('waitlistSubscribe.subscribe', function () {
    it('creates a PENDING row for a new (email, sku) and returns subscribed', function () {
        var t = load();
        t.getCustomObject.returns(null); // nothing existing → create

        var result = t.mod.subscribe('Shopper@Example.com', ' SKU-1 ', 'en_US');

        expect(result).to.deep.equal({success: true, status: 'subscribed'});
        // Keyed on the CLEANED (lowercased + trimmed) email and trimmed sku.
        sinon.assert.calledWith(t.keyMake, 'shopper@example.com', 'SKU-1');
        sinon.assert.calledWith(t.createCustomObject, 'WaitlistSubscription', 'key(shopper@example.com|SKU-1)');

        // Row shape: normalized email, variant sku, PENDING, locale, timestamp, 0 attempts.
        expect(t.created.custom).to.deep.equal({
            email: 'shopper@example.com',
            productID: 'SKU-1',
            status: 'PENDING',
            locale: 'en_US',
            createdAt: FIXED_TIME,
            attemptCount: 0
        });
    });

    it('detects an existing row and returns already-subscribed WITHOUT creating', function () {
        var t = load();
        t.getCustomObject.returns({custom: {status: 'PENDING'}});

        var result = t.mod.subscribe('shopper@example.com', 'SKU-1', 'en_US');

        expect(result).to.deep.equal({success: true, status: 'already-subscribed'});
        sinon.assert.notCalled(t.createCustomObject); // idempotent: no duplicate insert
    });

    it('rejects a missing account email with no-account-email (never persists)', function () {
        var t = load();
        var result = t.mod.subscribe('   ', 'SKU-1', 'en_US');
        expect(result).to.deep.equal({success: false, error: 'no-account-email'});
        sinon.assert.notCalled(t.getCustomObject);
        sinon.assert.notCalled(t.createCustomObject);
    });

    it('rejects a missing sku with invalid-sku (checked after the email)', function () {
        var t = load();
        var result = t.mod.subscribe('shopper@example.com', '   ', 'en_US');
        expect(result).to.deep.equal({success: false, error: 'invalid-sku'});
        sinon.assert.notCalled(t.createCustomObject);
    });
});
