'use strict';

/**
 * Business Manager controller for the Waitlist Demand Report.
 *
 * Controllers run in the BM context without pipelines: the globals request,
 * response and session are available. Every entry point is gated on
 * session.userAuthenticated (defence in depth on top of the BM module grant),
 * and each exported node is registered in bm_extensions.xml's <sub-pipelines>.
 *
 * The aggregation lives in app_waitlist so the scheduled export job and this
 * page share one code path. That requires app_waitlist to also be on the
 * Business Manager site's cartridge path (path = bm_waitlist:app_waitlist), so
 * the path-relative require below resolves waitlistDemand here.
 */

var ISML = require('dw/template/ISML');
var Logger = require('dw/system/Logger');
var waitlistDemand = require('*/cartridge/scripts/helpers/waitlistDemand');

var log = Logger.getLogger('bm', 'WaitlistReport');

/**
 * Render the ranked demand table.
 * Wired to <exec pipeline="WaitlistReport" node="Start"/>.
 */
function Start() {
    if (!session.userAuthenticated) {
        response.setStatus(403);
        return;
    }
    var report;
    try {
        report = waitlistDemand.build();
    } catch (e) {
        log.error('Failed to build waitlist demand report: {0}', e.message);
        report = { rows: [], totals: {}, generatedAt: new Date(), error: e.message };
    }
    ISML.renderTemplate('extensions/waitlist/report', { report: report });
}
Start.public = true;

/**
 * Stream the same report as a CSV download.
 * Wired to <exec pipeline="WaitlistReport" node="Export"/>.
 */
function Export() {
    if (!session.userAuthenticated) {
        response.setStatus(403);
        return;
    }
    var report = waitlistDemand.build();
    response.setContentType('text/csv; charset=UTF-8');
    response.setHttpHeader('Content-Disposition', 'attachment; filename="waitlist-demand.csv"');
    response.getWriter().print(waitlistDemand.toCsv(report));
}
Export.public = true;

module.exports.Start = Start;
module.exports.Export = Export;
