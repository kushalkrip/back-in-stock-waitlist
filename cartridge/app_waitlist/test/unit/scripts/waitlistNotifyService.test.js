'use strict';

/**
 * Unit tests for the outbound notify service (scripts/services/waitlistNotifyService.js).
 *
 * The module registers a LocalServiceRegistry service by handing it a config
 * object of callbacks (createRequest / parseResponse / mockCall /
 * filterLogMessage). We stub createService to CAPTURE that config, then drive
 * each callback directly — that's where the request shaping and (critically) the
 * PII log-scrubbing live.
 */
var chai = require('chai');
var proxyquire = require('proxyquire').noCallThru();
var expect = chai.expect;

var captured;
function load() {
    captured = null;
    proxyquire('../../../cartridge/scripts/services/waitlistNotifyService', {
        'dw/svc/LocalServiceRegistry': {
            createService: function (name, config) {
                captured = {name: name, config: config};
                return {__service: name}; // stand-in service object
            }
        }
    });
    return captured;
}

// A fake dw HTTP service that records method + headers.
function fakeSvc() {
    return {
        method: null,
        headers: {},
        setRequestMethod: function (m) { this.method = m; },
        addHeader: function (k, v) { this.headers[k] = v; }
    };
}

describe('waitlistNotifyService', function () {
    it('registers under the configured service id', function () {
        expect(load().name).to.equal('waitlist.http.notify');
    });

    describe('createRequest', function () {
        it('POSTs a JSON back-in-stock payload and returns the serialized body', function () {
            var cfg = load().config;
            var svc = fakeSvc();
            var body = cfg.createRequest(svc, {
                email: 'a@b.com',
                sku: 'SKU-1',
                productName: 'Cool Tee',
                locale: 'en_US'
            });

            expect(svc.method).to.equal('POST');
            expect(svc.headers['Content-Type']).to.equal('application/json');
            expect(JSON.parse(body)).to.deep.equal({
                to: 'a@b.com',
                template: 'back-in-stock',
                product: {sku: 'SKU-1', name: 'Cool Tee'},
                locale: 'en_US'
            });
        });
    });

    describe('parseResponse', function () {
        it('returns just the HTTP status code', function () {
            var cfg = load().config;
            expect(cfg.parseResponse(fakeSvc(), {statusCode: 202, text: 'whatever'})).to.equal(202);
        });
    });

    describe('mockCall', function () {
        it('returns a 200 so the job runs end-to-end without a credential', function () {
            var cfg = load().config;
            expect(cfg.mockCall().statusCode).to.equal(200);
        });
    });

    describe('filterLogMessage (PII hygiene)', function () {
        it('scrubs email addresses from anything written to platform logs', function () {
            var cfg = load().config;
            var scrubbed = cfg.filterLogMessage('sent to shopper@example.com and admin@corp.co ok');
            expect(scrubbed).to.not.contain('shopper@example.com');
            expect(scrubbed).to.not.contain('admin@corp.co');
            expect(scrubbed).to.contain('***@***');
        });

        it('leaves email-free messages untouched', function () {
            var cfg = load().config;
            expect(cfg.filterLogMessage('status 200 OK')).to.equal('status 200 OK');
        });
    });
});
