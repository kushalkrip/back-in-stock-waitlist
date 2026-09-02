'use strict';

/**
 * Unit tests for the login-redirect override (scripts/helpers/accountHelpers.js).
 *
 * This is a `module.superModule` override: it re-exports every base member and
 * replaces only getLoginRedirectURL to bounce a post-Notify-Me login back to the
 * product page. Node has no `module.superModule`, so we compile the file in a
 * Module whose `superModule` we control — that's the only dependency the file has.
 */
var chai = require('chai');
var sinon = require('sinon');
var Module = require('module');
var path = require('path');
var fs = require('fs');
var expect = chai.expect;

var SRC = path.resolve(__dirname, '../../../cartridge/scripts/helpers/accountHelpers.js');

// Compile the source with an injected module.superModule.
function loadWith(superModule) {
    var code = fs.readFileSync(SRC, 'utf8');
    var m = new Module(SRC, module);
    m.filename = SRC;
    m.paths = Module._nodeModulePaths(path.dirname(SRC));
    m.superModule = superModule;
    m._compile(code, SRC);
    return m.exports;
}

// A privacyCache stub backed by a plain map.
function privacyCache(initial) {
    var store = Object.assign({}, initial);
    return {
        store: store,
        get: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        set: function (k, v) { store[k] = v; }
    };
}

describe('accountHelpers.getLoginRedirectURL (superModule override)', function () {
    var baseGetLoginRedirectURL;
    var base;

    beforeEach(function () {
        baseGetLoginRedirectURL = sinon.stub().returns('/base/account');
        base = {
            getLoginRedirectURL: baseGetLoginRedirectURL,
            getLoginRedirect: 'UNCHANGED', // an unrelated base member
            someOtherHelper: function () { return 'base-helper'; }
        };
    });

    it('prefers a stashed waitlist return URL over base behaviour', function () {
        var helpers = loadWith(base);
        var cache = privacyCache({waitlistReturnUrl: '/s/RefArch/cool-tee/SKU-1.html'});

        var url = helpers.getLoginRedirectURL('rurl=1', cache, false);

        expect(url).to.equal('/s/RefArch/cool-tee/SKU-1.html');
        sinon.assert.notCalled(baseGetLoginRedirectURL); // base never consulted
    });

    it('consumes the stash one-shot (clears it so a later login uses base)', function () {
        var helpers = loadWith(base);
        var cache = privacyCache({waitlistReturnUrl: '/s/RefArch/cool-tee/SKU-1.html'});

        helpers.getLoginRedirectURL('rurl=1', cache, false);
        expect(cache.get('waitlistReturnUrl')).to.equal(null); // cleared

        // A subsequent login with no stash falls through to base.
        var next = helpers.getLoginRedirectURL('rurl=1', cache, false);
        expect(next).to.equal('/base/account');
        sinon.assert.calledOnce(baseGetLoginRedirectURL);
    });

    it('delegates to base (with the original args) when there is no stash', function () {
        var helpers = loadWith(base);
        var cache = privacyCache({});

        var url = helpers.getLoginRedirectURL('rurl=2', cache, true);

        expect(url).to.equal('/base/account');
        sinon.assert.calledOnceWithExactly(baseGetLoginRedirectURL, 'rurl=2', cache, true);
    });

    it('re-exports every base member unchanged', function () {
        var helpers = loadWith(base);
        expect(helpers.getLoginRedirect).to.equal('UNCHANGED');
        expect(helpers.someOtherHelper()).to.equal('base-helper');
    });
});
