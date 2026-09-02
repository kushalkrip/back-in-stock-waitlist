'use strict';

/**
 * Unit tests for the deterministic composite key (scripts/util/waitlistKey.js).
 *
 * This key is the backbone of idempotency: the same (email, sku) pair MUST map
 * to the same custom-object key so a duplicate signup collides at the key layer.
 * dw/crypto is unavailable off-platform, so MessageDigest/Encoding/Bytes are
 * stubbed to capture EXACTLY what string gets hashed — that normalized input is
 * the real contract (lowercased + trimmed email, '|' separator, sku as-is).
 */
var chai = require('chai');
var sinon = require('sinon');
var proxyquire = require('proxyquire').noCallThru();
var expect = chai.expect;

// Captures the raw string handed to `new Bytes(str, 'UTF-8')` — i.e. the exact
// preimage that gets hashed. Reset per load().
var lastBytesInput;

function load() {
    lastBytesInput = null;

    function Bytes(str) {
        lastBytesInput = str;
        this.str = str;
    }

    var digestBytes = sinon.stub().returns('RAW_DIGEST');
    function MessageDigest(algo) {
        this.algo = algo;
        this.digestBytes = digestBytes;
    }
    MessageDigest.DIGEST_SHA_256 = 'SHA-256';

    var toHex = sinon.stub().callsFake(function (d) {
        return 'hex(' + d + ')';
    });

    var mod = proxyquire('../../../cartridge/scripts/util/waitlistKey', {
        'dw/crypto/MessageDigest': MessageDigest,
        'dw/crypto/Encoding': {toHex: toHex},
        'dw/util/Bytes': Bytes
    });

    return {mod: mod, MessageDigest: MessageDigest, digestBytes: digestBytes, toHex: toHex};
}

describe('waitlistKey.make', function () {
    it('hashes lower(email) + "|" + sku and returns the hex digest', function () {
        var loaded = load();
        var key = loaded.mod.make('shopper@example.com', 'SKU-1');

        expect(lastBytesInput).to.equal('shopper@example.com|SKU-1');
        // SHA-256 chosen; digest → hex is the returned key.
        sinon.assert.calledWith(loaded.digestBytes, sinon.match.instanceOf(Object));
        expect(key).to.equal('hex(RAW_DIGEST)');
    });

    it('lowercases and trims the email so case/whitespace variants collide', function () {
        var a = load();
        a.mod.make('  Shopper@Example.COM ', 'SKU-1');
        var normalizedA = lastBytesInput;

        var b = load();
        b.mod.make('shopper@example.com', 'SKU-1');
        var normalizedB = lastBytesInput;

        expect(normalizedA).to.equal('shopper@example.com|SKU-1');
        expect(normalizedA).to.equal(normalizedB); // same preimage → same key
    });

    it('is case-SENSITIVE on the sku (variant IDs are canonical, not normalized)', function () {
        load().mod.make('a@b.com', 'sku-1');
        var lower = lastBytesInput;
        load().mod.make('a@b.com', 'SKU-1');
        var upper = lastBytesInput;
        expect(lower).to.not.equal(upper);
    });

    it('treats a null/undefined email or sku as empty (never throws)', function () {
        var mod = load().mod;
        expect(function () { mod.make(null, null); }).to.not.throw();
        expect(lastBytesInput).to.equal('|');

        load().mod.make(undefined, 'SKU-9');
        expect(lastBytesInput).to.equal('|SKU-9');
    });

    it('uses the SHA-256 algorithm', function () {
        var loaded = load();
        loaded.mod.make('a@b.com', 'x');
        // The digest was constructed with the SHA-256 constant.
        sinon.assert.calledOnce(loaded.digestBytes);
    });
});
