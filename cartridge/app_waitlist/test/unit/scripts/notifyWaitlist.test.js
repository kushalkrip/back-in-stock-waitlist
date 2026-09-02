'use strict';

/**
 * Unit tests for the chunk notify job step (scripts/steps/notifyWaitlist.js).
 *
 * This is the resilience core of the feature — the four named problems live
 * here: variant-level inventory resolution (process), the per-SKU availability
 * cache (O(distinct SKUs) not O(rows)), partial replenishment (threshold), and
 * transient-vs-hard outbound failure handling (write → keep PENDING vs FAILED vs
 * expire). Every dw/* class + the outbound service is stubbed so the lifecycle
 * hooks can be driven directly.
 */
var chai = require('chai');
var sinon = require('sinon');
var proxyquire = require('proxyquire').noCallThru();
var expect = chai.expect;

var FIXED_TIME = new Date('2026-02-02T00:00:00Z');

// ── dw stubs ─────────────────────────────────────────────────────────────────
function makeStatus() {
    function Status(code, id, msg) {
        this.code = code;
        this.id = id;
        this.msg = msg;
    }
    Status.OK = 0;
    Status.ERROR = 1;
    return Status;
}

// A fake availability model: isInStock(threshold) → configurable.
function product(id, name, inStock) {
    return {
        ID: id,
        name: name,
        getAvailabilityModel: sinon.stub().returns({
            isInStock: sinon.stub().returns(inStock)
        })
    };
}

// A fake WaitlistSubscription custom object.
function row(sku, extra) {
    return {custom: Object.assign({productID: sku, email: 'a@b.com', locale: 'en_US'}, extra || {})};
}

// A dw.svc.Result-like object.
function okResult() {
    return {isOk: function () { return true; }, getUnavailableReason: function () { return null; }};
}
function transientResult(reason) {
    return {isOk: function () { return false; }, getUnavailableReason: function () { return reason; }};
}
function hardResult() {
    return {isOk: function () { return false; }, getUnavailableReason: function () { return null; }};
}

function load(overrides) {
    overrides = overrides || {};
    var Status = makeStatus();

    var queryCustomObjects = sinon.stub();
    var getProduct = sinon.stub();
    var svcCall = sinon.stub().returns(okResult());
    var warn = sinon.stub();

    var mod = proxyquire('../../../cartridge/scripts/steps/notifyWaitlist', {
        'dw/object/CustomObjectMgr': {
            queryCustomObjects: function () { return queryCustomObjects.apply(null, arguments); }
        },
        'dw/catalog/ProductMgr': {
            getProduct: function () { return getProduct.apply(null, arguments); }
        },
        'dw/system/Transaction': {wrap: function (cb) { return cb(); }},
        'dw/util/Calendar': function Calendar() {
            this.getTime = function () { return FIXED_TIME; };
        },
        'dw/system/Status': Status,
        'dw/system/Logger': {
            getLogger: function () { return {warn: warn, info: sinon.stub(), error: sinon.stub()}; }
        },
        '*/cartridge/scripts/services/waitlistNotifyService': {
            call: function () { return svcCall.apply(null, arguments); }
        }
    });

    return {
        mod: mod,
        Status: Status,
        queryCustomObjects: queryCustomObjects,
        getProduct: getProduct,
        svcCall: svcCall,
        warn: warn
    };
}

describe('notifyWaitlist chunk step', function () {
    describe('beforeStep / getTotalCount / read', function () {
        it('queries only PENDING rows, sorted for the per-SKU cache + FIFO', function () {
            var t = load();
            t.queryCustomObjects.returns({count: 7, hasNext: function () { return false; }});

            t.mod.beforeStep({NotifyThreshold: 3});

            var args = t.queryCustomObjects.firstCall.args;
            expect(args[0]).to.equal('WaitlistSubscription');
            expect(args[1]).to.equal('custom.status = {0}');
            expect(args[2]).to.equal('custom.productID asc, custom.createdAt asc');
            expect(args[3]).to.equal('PENDING');
            expect(t.mod.getTotalCount()).to.equal(7);
        });

        it('read() drains the iterator then returns undefined', function () {
            var t = load();
            var rows = [row('A'), row('B')];
            var i = 0;
            t.queryCustomObjects.returns({
                count: 2,
                hasNext: function () { return i < rows.length; },
                next: function () { return rows[i++]; }
            });
            t.mod.beforeStep({});
            expect(t.mod.read()).to.equal(rows[0]);
            expect(t.mod.read()).to.equal(rows[1]);
            expect(t.mod.read()).to.equal(undefined);
        });
    });

    describe('process (variant inventory resolution)', function () {
        function primed(t) {
            t.queryCustomObjects.returns({count: 0, hasNext: function () { return false; }});
            t.mod.beforeStep({NotifyThreshold: 2});
        }

        it('returns a notify item for an in-stock variant, checked against the threshold', function () {
            var t = load();
            primed(t);
            var p = product('SKU-1', 'Cool Tee', true);
            t.getProduct.returns(p);

            var item = t.mod.process(row('SKU-1'));

            expect(item).to.include({expire: false, email: 'a@b.com', sku: 'SKU-1', productName: 'Cool Tee', locale: 'en_US'});
            // Availability is evaluated at the configured threshold (partial-restock guard).
            sinon.assert.calledWith(p.getAvailabilityModel().isInStock, 2);
        });

        it('skips (undefined) an out-of-stock variant so the row stays PENDING', function () {
            var t = load();
            primed(t);
            t.getProduct.returns(product('SKU-1', 'Cool Tee', false));
            expect(t.mod.process(row('SKU-1'))).to.equal(undefined);
        });

        it('checks availability ONCE per distinct SKU (the per-SKU cache)', function () {
            var t = load();
            primed(t);
            var p = product('SKU-1', 'Cool Tee', true);
            t.getProduct.returns(p);

            t.mod.process(row('SKU-1'));
            t.mod.process(row('SKU-1')); // same SKU, consecutive (query is sorted)

            // getAvailabilityModel() returns a fresh stub each call in the fake, so
            // assert on the source: it was only invoked once → cache hit on row 2.
            sinon.assert.calledOnce(p.getAvailabilityModel);
        });

        it('skips an orphaned SKU under the attempt cap (leaves it PENDING)', function () {
            var t = load();
            primed(t);
            t.getProduct.returns(null);
            expect(t.mod.process(row('GONE', {attemptCount: 2}))).to.equal(undefined);
        });

        it('expires an orphaned SKU once it hits the attempt cap', function () {
            var t = load();
            primed(t);
            t.getProduct.returns(null);
            var item = t.mod.process(row('GONE', {attemptCount: 5}));
            expect(item).to.deep.include({expire: true});
        });
    });

    describe('write (outbound send + idempotent status commit)', function () {
        function primed(t) {
            t.queryCustomObjects.returns({
                count: 0,
                hasNext: function () { return false; },
                close: function () {}
            });
            t.mod.beforeStep({});
        }

        it('marks a row NOTIFIED with a timestamp on a successful send', function () {
            var t = load();
            primed(t);
            t.svcCall.returns(okResult());
            var r = row('SKU-1', {attemptCount: 0});

            t.mod.write([{expire: false, row: r, email: 'a@b.com', sku: 'SKU-1', productName: 'Tee', locale: 'en_US'}]);

            expect(r.custom.status).to.equal('NOTIFIED');
            expect(r.custom.notifiedAt).to.equal(FIXED_TIME);
            expect(r.custom.attemptCount).to.equal(1);
            sinon.assert.calledWithMatch(t.svcCall, {email: 'a@b.com', sku: 'SKU-1', productName: 'Tee', locale: 'en_US'});
        });

        it('keeps a row PENDING on a TRANSIENT failure and flags a warning status', function () {
            var t = load();
            primed(t);
            t.svcCall.returns(transientResult('RATE_LIMITED'));
            var r = row('SKU-1', {attemptCount: 0});

            t.mod.write([{expire: false, row: r, sku: 'SKU-1'}]);

            expect(r.custom.status).to.equal(undefined); // untouched → still PENDING
            expect(r.custom.attemptCount).to.equal(1); // attempt still counted
            sinon.assert.called(t.warn);

            var status = t.mod.afterStep(true);
            expect(status.msg).to.match(/deferred/i); // FINISHED_WITH_WARNINGS
        });

        it('leaves a row PENDING on a hard failure below the attempt cap', function () {
            var t = load();
            primed(t);
            t.svcCall.returns(hardResult());
            var r = row('SKU-1', {attemptCount: 0});
            t.mod.write([{expire: false, row: r, sku: 'SKU-1'}]);
            expect(r.custom.status).to.equal(undefined);
            expect(r.custom.attemptCount).to.equal(1);
        });

        it('marks a row FAILED on a hard failure that reaches the attempt cap', function () {
            var t = load();
            primed(t);
            t.svcCall.returns(hardResult());
            var r = row('SKU-1', {attemptCount: 4}); // → 5 after increment = MAX
            t.mod.write([{expire: false, row: r, sku: 'SKU-1'}]);
            expect(r.custom.status).to.equal('FAILED');
        });

        it('marks an expired item FAILED without calling the service', function () {
            var t = load();
            primed(t);
            var r = row('GONE');
            t.mod.write([{expire: true, row: r}]);
            expect(r.custom.status).to.equal('FAILED');
            sinon.assert.notCalled(t.svcCall);
        });
    });

    describe('afterStep', function () {
        it('closes the iterator and returns OK with no transient failures', function () {
            var t = load();
            var close = sinon.stub();
            t.queryCustomObjects.returns({count: 0, hasNext: function () { return false; }, close: close});
            t.mod.beforeStep({});

            var status = t.mod.afterStep(true);

            sinon.assert.calledOnce(close);
            expect(status.code).to.equal(t.Status.OK);
            expect(status.msg).to.equal(undefined); // plain OK, no warning message
        });
    });
});
