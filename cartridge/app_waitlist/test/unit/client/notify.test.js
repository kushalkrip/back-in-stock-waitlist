'use strict';

/**
 * Unit tests for the PURE decision logic of the PDP Notify Me client module.
 * The DOM wiring in init() is exercised end-to-end on the storefront; here we
 * lock down the branch-y logic that used to be buried in an inline <script>.
 */

var assert = require('chai').assert;
var notify = require('../../../cartridge/client/default/js/waitlist/notify');

describe('client/waitlist/notify (pure logic)', function () {
    describe('shouldShowNotify', function () {
        it('shows for a resolved, out-of-stock, non-set/bundle variant', function () {
            assert.isTrue(notify.shouldShowNotify({ readyToOrder: true, available: false, productType: 'variant' }));
        });
        it('hides when the variant is available', function () {
            assert.isFalse(notify.shouldShowNotify({ readyToOrder: true, available: true, productType: 'variant' }));
        });
        it('hides when the variant is not fully resolved', function () {
            assert.isFalse(notify.shouldShowNotify({ readyToOrder: false, available: false, productType: 'variant' }));
        });
        it('hides for sets and bundles even when out of stock', function () {
            assert.isFalse(notify.shouldShowNotify({ readyToOrder: true, available: false, productType: 'set' }));
            assert.isFalse(notify.shouldShowNotify({ readyToOrder: true, available: false, productType: 'bundle' }));
        });
        it('hides for a null/undefined product', function () {
            assert.isFalse(notify.shouldShowNotify(null));
            assert.isFalse(notify.shouldShowNotify(undefined));
        });
        it('treats a missing available flag as not-shown (strict false only)', function () {
            assert.isFalse(notify.shouldShowNotify({ readyToOrder: true, productType: 'variant' }));
        });
        it('shows for a wholly sold-out master even with no resolved variant', function () {
            // base SFRA greys every OOS variation value, so the master can never
            // resolve a variant; !available on a master == zero orderable variants.
            assert.isTrue(notify.shouldShowNotify({ readyToOrder: false, available: false, productType: 'master' }));
        });
        it('hides for a master that is still available (some variant in stock)', function () {
            assert.isFalse(notify.shouldShowNotify({ readyToOrder: false, available: true, productType: 'master' }));
        });
    });

    describe('buildSubscribeBody', function () {
        it('encodes sku and the named token', function () {
            assert.equal(
                notify.buildSubscribeBody('abc 123', 'csrf_token', 'tok/en+='),
                'sku=abc%20123&csrf_token=tok%2Fen%2B%3D'
            );
        });
        it('defaults the token field name to csrf_token', function () {
            assert.equal(notify.buildSubscribeBody('sku1', undefined, 't1'), 'sku=sku1&csrf_token=t1');
        });
        it('encodes a custom token field name', function () {
            assert.equal(notify.buildSubscribeBody('sku1', 'csrf token', 't1'), 'sku=sku1&csrf%20token=t1');
        });
    });

    describe('stripWlNotified', function () {
        it('removes a sole marker, leaving a clean query', function () {
            assert.equal(notify.stripWlNotified('?wlnotified=1'), '');
        });
        it('removes a leading marker and keeps the rest', function () {
            assert.equal(notify.stripWlNotified('?wlnotified=1&foo=bar'), '?foo=bar');
        });
        it('removes a trailing marker and keeps the rest', function () {
            assert.equal(notify.stripWlNotified('?foo=bar&wlnotified=1'), '?foo=bar');
        });
        it('leaves an unrelated query untouched', function () {
            assert.equal(notify.stripWlNotified('?foo=bar'), '?foo=bar');
            assert.equal(notify.stripWlNotified(''), '');
        });
    });
});
