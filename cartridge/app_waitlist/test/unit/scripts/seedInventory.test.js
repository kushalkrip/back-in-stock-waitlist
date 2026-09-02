'use strict';

/**
 * Unit tests for the DEMO-ONLY inventory seeder (scripts/steps/seedInventory.js).
 *
 * This step flips the SKUs shoppers are waiting on in/out of stock on a sandbox
 * without Business Manager clicks. It never CREATES inventory records — it
 * updates the allocation on records that already exist in the current site's
 * inventory list — so the tests assert the record mutations (setAllocation with
 * a reset date + setPerpetual(false)), the PENDING-derived SKU list (distinct +
 * limited), and the guard when no inventory list is assigned.
 */
var chai = require('chai');
var sinon = require('sinon');
var proxyquire = require('proxyquire').noCallThru();
var expect = chai.expect;

function makeStatus() {
    function Status(code, id, msg) { this.code = code; this.id = id; this.msg = msg; }
    Status.OK = 0;
    Status.ERROR = 1;
    return Status;
}

// A fake inventory record capturing the writes.
function record() {
    return {
        allocation: null,
        resetDate: null,
        perpetual: null,
        setAllocation: function (qty, date) { this.allocation = qty; this.resetDate = date; },
        setPerpetual: function (v) { this.perpetual = v; }
    };
}

// A fake inventory list: getRecord returns a seeded record or null.
function inventoryList(records) {
    return {
        ID: 'inventory-m',
        getRecord: function (sku) { return records[sku] || null; }
    };
}

// A fake PENDING query over the given SKUs.
function pendingIterator(skus) {
    var i = 0;
    return {
        closed: false,
        hasNext: function () { return i < skus.length; },
        next: function () { return {custom: {productID: skus[i++]}}; },
        close: function () { this.closed = true; }
    };
}

function load(opts) {
    opts = opts || {};
    var Status = makeStatus();
    var query = sinon.stub().returns(pendingIterator(opts.pending || []));

    var mod = proxyquire('../../../cartridge/scripts/steps/seedInventory', {
        'dw/object/CustomObjectMgr': {
            queryCustomObjects: function () { return query.apply(null, arguments); }
        },
        'dw/catalog/ProductInventoryMgr': {
            getInventoryList: function () { return 'list' in opts ? opts.list : inventoryList(opts.records || {}); }
        },
        'dw/system/Transaction': {wrap: function (cb) { return cb(); }},
        'dw/system/Status': Status,
        'dw/system/Logger': {getLogger: function () { return {info: sinon.stub(), warn: sinon.stub()}; }}
    });

    return {mod: mod, Status: Status, query: query};
}

describe('seedInventory demo step', function () {
    it('restocks explicit SKUs: sets allocation to SeedQty with a reset date + perpetual false', function () {
        var recs = {'SKU-1': record(), 'SKU-2': record()};
        var t = load({records: recs});

        var status = t.mod.execute({Skus: 'SKU-1, SKU-2', SeedQty: 100, Restock: true});

        expect(status.code).to.equal(t.Status.OK);
        expect(recs['SKU-1'].allocation).to.equal(100);
        expect(recs['SKU-1'].resetDate).to.be.instanceOf(Date);
        expect(recs['SKU-1'].perpetual).to.equal(false);
        expect(recs['SKU-2'].allocation).to.equal(100);
    });

    it('zeroes allocation when Restock is false (reset to OOS)', function () {
        var recs = {'SKU-1': record()};
        var t = load({records: recs});
        t.mod.execute({Skus: 'SKU-1', SeedQty: 100, Restock: false});
        expect(recs['SKU-1'].allocation).to.equal(0);
    });

    it('defaults SeedQty to 100 when omitted', function () {
        var recs = {'SKU-1': record()};
        var t = load({records: recs});
        t.mod.execute({Skus: 'SKU-1', Restock: true});
        expect(recs['SKU-1'].allocation).to.equal(100);
    });

    it('counts SKUs with no inventory record as missing (does not throw)', function () {
        var recs = {'SKU-1': record()}; // SKU-2 absent
        var t = load({records: recs});
        var status = t.mod.execute({Skus: 'SKU-1,SKU-2', Restock: true});
        expect(status.code).to.equal(t.Status.OK);
        expect(status.msg).to.contain('1 had no record');
    });

    it('derives the SKU list from distinct PENDING subscriptions when no Skus param', function () {
        var recs = {'SKU-1': record(), 'SKU-2': record()};
        // Duplicate SKU-1 in the pending set → must be de-duplicated.
        var t = load({records: recs, pending: ['SKU-1', 'SKU-1', 'SKU-2']});

        t.mod.execute({Restock: true, SeedQty: 50});

        sinon.assert.calledWithMatch(t.query, 'WaitlistSubscription', 'custom.status = {0}', 'custom.productID asc', 'PENDING');
        expect(recs['SKU-1'].allocation).to.equal(50);
        expect(recs['SKU-2'].allocation).to.equal(50);
    });

    it('honours SeedLimit by touching at most N distinct SKUs', function () {
        var recs = {'SKU-1': record(), 'SKU-2': record()};
        var t = load({records: recs, pending: ['SKU-1', 'SKU-2']});
        t.mod.execute({Restock: true, SeedLimit: 1, SeedQty: 5});
        // Only the first distinct SKU is restocked; the second is left WAITING.
        expect(recs['SKU-1'].allocation).to.equal(5);
        expect(recs['SKU-2'].allocation).to.equal(null);
    });

    it('returns ERROR NO_LIST when the site has no inventory list', function () {
        var t = load({list: null});
        var status = t.mod.execute({Skus: 'SKU-1'});
        expect(status.code).to.equal(t.Status.ERROR);
        expect(status.id).to.equal('NO_LIST');
    });
});
