'use strict';

/**
 * Minimal stand-in for the SFRA `server` module for unit tests.
 *
 * The real `server` lives in app_storefront_base (not present in this cartridge
 * repo), so we fake exactly the surface WaitList.js uses: `post`, `get`,
 * `middleware.https`, and `exports`. Each route registration captures its full
 * middleware chain (…middlewares, handler) so a test can pull a route by name
 * and invoke the final handler directly with a fake (req, res, next) — or assert
 * that the login / CSRF middlewares are present in the chain.
 *
 * A fresh instance is created per require via `factory()`; proxyquire hands the
 * SAME instance to the controller under test and to the test file (see the
 * `@global`/noCallThru wiring in the spec), so captured routes are observable.
 */
function factory() {
    var routes = {};

    function register(name) {
        // arguments after `name` are the middleware chain + handler.
        routes[name] = Array.prototype.slice.call(arguments, 1);
    }

    return {
        post: register,
        get: register,
        middleware: {
            // Pass-through; the real one enforces HTTPS, irrelevant to logic tests.
            https: function https(req, res, next) {
                return next();
            }
        },
        exports: function exports() {
            return {__routes: routes};
        },
        // Test helpers (not part of the real server API).
        __getHandler: function __getHandler(name) {
            var chain = routes[name];
            return chain[chain.length - 1];
        },
        __getChain: function __getChain(name) {
            return routes[name];
        }
    };
}

module.exports = factory();
