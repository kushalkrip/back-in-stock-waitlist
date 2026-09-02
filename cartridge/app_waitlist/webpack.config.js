'use strict';

/**
 * Build for the app_waitlist client bundle.
 *
 * Compiles the CommonJS source under cartridge/client/default/js into the
 * deployable static asset cartridge/static/default/js/waitlist.js, which the
 * PDP loads via assets.addJs('/js/waitlist.js'). This mirrors the SFRA
 * convention (client/ -> static/) so no behavioural JS ships inside ISML.
 *
 *   npm run build   # produce the static bundle
 *
 * The source is authored in browser-safe ES5, so no Babel step is required;
 * webpack only bundles and minifies.
 */

var path = require('path');

module.exports = {
    mode: 'production',
    devtool: false,
    entry: {
        waitlist: './cartridge/client/default/js/waitlist.js'
    },
    output: {
        path: path.resolve(__dirname, 'cartridge/static/default/js'),
        filename: '[name].js'
    },
    target: ['web', 'es5']
};
