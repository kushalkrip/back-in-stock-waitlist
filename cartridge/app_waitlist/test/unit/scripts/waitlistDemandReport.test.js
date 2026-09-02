'use strict';

/**
 * Unit tests for the CSV export step (scripts/steps/waitlistDemandReport.js).
 *
 * The step aggregates the SAME demand report the BM page shows, then writes it
 * as a timestamped CSV under IMPEX. We stub the dw/io File + FileWriter classes
 * to capture what path is created and what bytes are written, and assert the
 * mkdirs-when-missing branch and the error → Status.ERROR mapping.
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

var REPORT = {
    rows: [{sku: 'SKU-1', waiting: 3}],
    totals: {skus: 1, waiting: 3, oosWithDemand: 1}
};

function load(opts) {
    opts = opts || {};
    var Status = makeStatus();

    // File: constructed twice — once for the dir, once for the target file.
    var dirExists = 'dirExists' in opts ? opts.dirExists : true;
    var mkdirs = sinon.stub();
    var writes = [];
    var writerClosed = {value: false};

    function File(a, b) {
        // dir constructor: new File(IMPEX + SEP + folder) — single string arg.
        // file constructor: new File(dir, name).
        if (typeof b === 'undefined') {
            this.isDir = true;
            this.exists = function () { return dirExists; };
            this.mkdirs = mkdirs;
        } else {
            this.name = b;
            this.getFullPath = function () { return '/impex/reports/' + b; };
            this.getName = function () { return b; };
        }
    }
    File.IMPEX = '/impex';
    File.SEPARATOR = '/';

    function FileWriter() {}
    FileWriter.prototype.write = function (s) { writes.push(s); };
    FileWriter.prototype.close = function () { writerClosed.value = true; };

    var build = opts.buildThrows
        ? sinon.stub().throws(new Error('aggregation failed'))
        : sinon.stub().returns(REPORT);
    var toCsv = sinon.stub().returns('sku,waiting\nSKU-1,3\n');

    var mod = proxyquire('../../../cartridge/scripts/steps/waitlistDemandReport', {
        'dw/io/File': File,
        'dw/io/FileWriter': FileWriter,
        'dw/system/Status': Status,
        'dw/system/Logger': {getLogger: function () { return {info: sinon.stub(), error: sinon.stub()}; }},
        'dw/system/Site': {getCurrent: function () { return {getID: function () { return 'RefArch'; }}; }},
        'dw/util/Calendar': function Calendar() {},
        'dw/util/StringUtils': {formatCalendar: function () { return '20260902-101500'; }},
        '*/cartridge/scripts/helpers/waitlistDemand': {build: build, toCsv: toCsv}
    });

    return {mod: mod, Status: Status, mkdirs: mkdirs, writes: writes, writerClosed: writerClosed, build: build, toCsv: toCsv};
}

describe('waitlistDemandReport export step', function () {
    it('writes the aggregated CSV and returns OK', function () {
        var t = load();
        var status = t.mod.execute({Threshold: 1});

        expect(status.code).to.equal(t.Status.OK);
        expect(t.writes).to.deep.equal(['sku,waiting\nSKU-1,3\n']);
        expect(t.writerClosed.value).to.equal(true); // writer always closed
        sinon.assert.calledWithMatch(t.build, {threshold: 1});
        // Filename carries site id + timestamp so exports never collide.
        expect(status.msg).to.contain('1 SKUs');
    });

    it('creates the output directory when it does not yet exist', function () {
        var t = load({dirExists: false});
        t.mod.execute({});
        sinon.assert.calledOnce(t.mkdirs);
    });

    it('does not mkdirs when the directory already exists', function () {
        var t = load({dirExists: true});
        t.mod.execute({});
        sinon.assert.notCalled(t.mkdirs);
    });

    it('maps an aggregation failure to Status.ERROR', function () {
        var t = load({buildThrows: true});
        var status = t.mod.execute({});
        expect(status.code).to.equal(t.Status.ERROR);
        expect(status.msg).to.equal('aggregation failed');
    });
});
