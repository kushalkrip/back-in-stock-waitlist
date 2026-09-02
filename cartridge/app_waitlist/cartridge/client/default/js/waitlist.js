'use strict';

/**
 * Webpack entry for the app_waitlist client bundle. Compiled to
 * static/default/js/waitlist.js and loaded via assets.addJs from the PDP
 * add-to-cart override. Keeps the entry thin so the behaviour lives in an
 * independently testable module.
 */

var notify = require('./waitlist/notify');

function boot() { notify.init(document); }

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
