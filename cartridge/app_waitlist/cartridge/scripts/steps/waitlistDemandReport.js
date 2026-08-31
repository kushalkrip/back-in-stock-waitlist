'use strict';

/**
 * Task-oriented job step: aggregate the waitlist demand report and write it as
 * a CSV to IMPEX so a merchandiser can download it over WebDAV or feed it to a
 * BI pipeline on a schedule. This is the "export" half of the report layer; the
 * live view is the Business Manager page (bm_waitlist). Both consume the SAME
 * aggregation (scripts/helpers/waitlistDemand), so the ranking never diverges.
 *
 * Registered in ../../steptypes.json as custom.WaitlistDemandReport
 * (script-module-step, site-context).
 */

var File = require('dw/io/File');
var FileWriter = require('dw/io/FileWriter');
var Status = require('dw/system/Status');
var Logger = require('dw/system/Logger');
var Site = require('dw/system/Site');
var Calendar = require('dw/util/Calendar');
var StringUtils = require('dw/util/StringUtils');

var waitlistDemand = require('*/cartridge/scripts/helpers/waitlistDemand');

/**
 * @param {Object} params - {OutputFolder?: string, Threshold?: number}
 * @returns {dw.system.Status}
 */
exports.execute = function (params) {
    var log = Logger.getLogger('waitlist', 'demandReport');
    var threshold = (params && params.Threshold) || 1;
    var folderPath = (params && params.OutputFolder) || 'src/reports/waitlist';

    try {
        var report = waitlistDemand.build({ threshold: threshold });
        var csv = waitlistDemand.toCsv(report);

        var dir = new File(File.IMPEX + File.SEPARATOR + folderPath);
        if (!dir.exists()) { dir.mkdirs(); }

        var stamp = StringUtils.formatCalendar(new Calendar(), 'yyyyMMdd-HHmmss');
        var siteId = Site.getCurrent().getID();
        var file = new File(dir, 'waitlist-demand-' + siteId + '-' + stamp + '.csv');

        var writer = new FileWriter(file, 'UTF-8');
        try {
            writer.write(csv);
        } finally {
            writer.close();
        }

        log.info('Waitlist demand report written: {0} ({1} SKUs, {2} waiting, {3} OOS-with-demand)',
            file.getFullPath(), report.totals.skus, report.totals.waiting, report.totals.oosWithDemand);

        return new Status(Status.OK, 'OK',
            'Wrote ' + report.totals.skus + ' SKUs (' + report.totals.oosWithDemand
            + ' out-of-stock with demand) to ' + file.getName());
    } catch (e) {
        log.error('Waitlist demand report failed: {0}', e.message);
        return new Status(Status.ERROR, 'ERROR', e.message);
    }
};
