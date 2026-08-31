'use strict';

/**
 * Unit tests for the shared demand-aggregation module
 * (scripts/helpers/waitlistDemand.js). This is the single code path behind BOTH
 * report surfaces — the Business Manager page (bm_waitlist) and the scheduled
 * CSV export job — so its ranking/counting logic is worth pinning down with no
 * instance at all: dw/object/CustomObjectMgr and dw/catalog/ProductMgr are
 * stubbed via proxyquire, and we drive build()/toCsv() directly.
 */
var chai = require('chai');
var sinon = require('sinon');
var proxyquire = require('proxyquire').noCallThru();
var expect = chai.expect;

// A fake SeekableIterator over an array, tracking that close() was called.
function fakeIterator(rows) {
    var i = 0;
    return {
        closed: false,
        hasNext: function hasNext() { return i < rows.length; },
        next: function next() { return rows[i++]; },
        close: function close() { this.closed = true; }
    };
}

// Shorthand to build a fake WaitlistSubscription custom object.
function co(sku, status) {
    return { custom: { productID: sku, status: status } };
}

// Build a fake product whose availability + name we control.
function product(name, inStock) {
    return {
        name: name,
        getAvailabilityModel: function getAvailabilityModel() {
            return { isInStock: function isInStock() { return inStock; } };
        }
    };
}

function load(rows, products) {
    var iterator = fakeIterator(rows);
    var mod = proxyquire('../../../cartridge/scripts/helpers/waitlistDemand', {
        'dw/object/CustomObjectMgr': {
            getAllCustomObjects: function () { return iterator; }
        },
        'dw/catalog/ProductMgr': {
            getProduct: function (sku) { return products[sku] || null; }
        }
    });
    return { mod: mod, iterator: iterator };
}

describe('waitlistDemand', function () {
    describe('priorityFor', function () {
        var mod;
        beforeEach(function () { mod = load([], {}).mod; });

        it('flags a resolvable-but-offline product for REVIEW', function () {
            expect(mod.priorityFor({ waiting: 5 }, false, false)).to.equal('REVIEW');
        });
        it('reports IN_STOCK regardless of demand when available', function () {
            expect(mod.priorityFor({ waiting: 99 }, true, true)).to.equal('IN_STOCK');
        });
        it('scales HIGH/MEDIUM/LOW/NONE by waiting count when out of stock', function () {
            expect(mod.priorityFor({ waiting: 10 }, false, true)).to.equal('HIGH');
            expect(mod.priorityFor({ waiting: 3 }, false, true)).to.equal('MEDIUM');
            expect(mod.priorityFor({ waiting: 1 }, false, true)).to.equal('LOW');
            expect(mod.priorityFor({ waiting: 0 }, false, true)).to.equal('NONE');
        });
    });

    describe('build', function () {
        it('groups by SKU, counts by status, and always closes the iterator', function () {
            var rows = [
                co('A', 'PENDING'), co('A', 'PENDING'), co('A', 'NOTIFIED'),
                co('B', 'PENDING'), co('B', 'FAILED'),
                co(null, 'PENDING') // no SKU → skipped
            ];
            var loaded = load(rows, { A: product('Prod A', false), B: product('Prod B', false) });

            var report = loaded.mod.build();

            expect(loaded.iterator.closed).to.equal(true);
            expect(report.totals.skus).to.equal(2);
            expect(report.totals.waiting).to.equal(3);
            expect(report.totals.notified).to.equal(1);
            expect(report.totals.failed).to.equal(1);
            expect(report.totals.subscriptions).to.equal(5);
            expect(report.totals.oosWithDemand).to.equal(2);

            var a = report.rows.filter(function (r) { return r.sku === 'A'; })[0];
            expect(a.waiting).to.equal(2);
            expect(a.notified).to.equal(1);
            expect(a.total).to.equal(3);
            expect(a.productName).to.equal('Prod A');
        });

        it('ranks out-of-stock-with-demand ahead of in-stock, then by waiting count', function () {
            var rows = [
                co('IN', 'PENDING'),                                   // in stock -> IN_STOCK
                co('LOWDEM', 'PENDING'),                               // OOS, 1 waiting -> LOW
                co('HIGHDEM', 'PENDING'), co('HIGHDEM', 'PENDING'),
                co('HIGHDEM', 'PENDING'), co('HIGHDEM', 'PENDING')     // OOS, 4 waiting -> HIGH? no, MEDIUM(>=3)
            ];
            var report = load(rows, {
                IN: product('In Stock', true),
                LOWDEM: product('Low', false),
                HIGHDEM: product('High', false)
            }).mod.build();

            // MEDIUM (HIGHDEM) before LOW before IN_STOCK.
            expect(report.rows[0].sku).to.equal('HIGHDEM');
            expect(report.rows[0].priority).to.equal('MEDIUM');
            expect(report.rows[1].sku).to.equal('LOWDEM');
            expect(report.rows[1].priority).to.equal('LOW');
            expect(report.rows[2].sku).to.equal('IN');
            expect(report.rows[2].priority).to.equal('IN_STOCK');
        });

        it('marks a SKU whose product no longer resolves as REVIEW and not-in-stock', function () {
            var report = load([co('GONE', 'PENDING')], {}).mod.build();
            var row = report.rows[0];
            expect(row.productExists).to.equal(false);
            expect(row.inStock).to.equal(false);
            expect(row.priority).to.equal('REVIEW');
            expect(row.productName).to.equal('GONE'); // falls back to the SKU
            expect(report.totals.oosWithDemand).to.equal(0); // only counts resolvable products
        });
    });

    describe('toCsv', function () {
        it('emits a header plus one row per SKU with RFC-4180 quoting', function () {
            var report = load(
                [co('SKU-1', 'PENDING')],
                { 'SKU-1': product('Fancy, "Quoted" Tee', false) }
            ).mod.build();

            var csv = load([], {}).mod.toCsv(report);
            var lines = csv.trim().split('\n');
            expect(lines[0]).to.equal('SKU,Product,Waiting,Notified,Failed,InStock,Priority');
            // Comma + embedded quotes force quoting with doubled inner quotes.
            expect(lines[1]).to.equal('SKU-1,"Fancy, ""Quoted"" Tee",1,0,0,no,LOW');
        });
    });
});
