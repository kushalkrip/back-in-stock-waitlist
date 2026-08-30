'use strict';

/**
 * Outbound "send the back-in-stock email" service.
 *
 * The real email send is simulated by POSTing to a webhook.site URL. All the
 * resilience (timeout, circuit breaker, rate limiter) is configured on the BM
 * Service Profile -- this module just shapes the request/response and gives us
 * a safe mock for sandboxes without the credential configured.
 *
 * service.call(payload) returns a dw.svc.Result; the caller inspects
 * result.isOk() and result.getUnavailableReason() rather than throwing, so a
 * transient failure can leave the waitlist row PENDING for the next run.
 */

var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');

var EMAIL_RE = /[\w.+-]+@[\w.-]+\.[\w.-]+/g;

module.exports = LocalServiceRegistry.createService('waitlist.http.notify', {
    /**
     * Build the outbound request. `svc` is the HTTP service, `payload` is what
     * the job passes to .call().
     */
    createRequest: function (svc, payload) {
        svc.setRequestMethod('POST');
        svc.addHeader('Content-Type', 'application/json');
        return JSON.stringify({
            to: payload.email,
            template: 'back-in-stock',
            product: {
                sku: payload.sku,
                name: payload.productName
            },
            locale: payload.locale
        });
    },

    /**
     * We only care whether the send was accepted; return the status code.
     */
    parseResponse: function (svc, response) {
        return response.statusCode;
    },

    /**
     * Lets the job run end-to-end on a sandbox that has no credential wired up.
     * Flip the service to "mock" mode in BM to exercise this path.
     */
    mockCall: function () {
        return { statusCode: 200, text: 'OK (mock)' };
    },

    /**
     * PII hygiene: scrub email addresses from anything written to platform logs.
     */
    filterLogMessage: function (msg) {
        return String(msg).replace(EMAIL_RE, '***@***');
    }
});
