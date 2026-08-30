'use strict';

/**
 * Deterministic composite key for a waitlist subscription.
 *
 * key = sha256( lower(email) + '|' + sku )  -> hex string
 *
 * Why hash instead of "email__sku": custom-object keys are length- and
 * charset-constrained, and raw emails contain '@', '.', '+' which are awkward
 * in keys/URLs. A sha256 hex digest is fixed-length, safe, and collision-proof
 * for our purposes. The same (email, sku) pair always maps to the same key, so
 * a duplicate signup collides at the key layer.
 *
 * NOTE: this is defense-in-depth. The SCAPI handler still does an explicit
 * query-before-insert (see rest-apis/waitlist/script.js) because the platform
 * behavior of createCustomObject() on an existing key is undocumented.
 */

var MessageDigest = require('dw/crypto/MessageDigest');
var Encoding = require('dw/crypto/Encoding');
var Bytes = require('dw/util/Bytes');

/**
 * @param {string} email - shopper email (any case)
 * @param {string} sku - variant product ID
 * @returns {string} lowercase hex sha256 digest
 */
function make(email, sku) {
    var normalized = String(email || '').trim().toLowerCase() + '|' + String(sku || '');
    var digest = new MessageDigest(MessageDigest.DIGEST_SHA_256);
    var hashed = digest.digestBytes(new Bytes(normalized, 'UTF-8'));
    return Encoding.toHex(hashed);
}

module.exports = {
    make: make
};
