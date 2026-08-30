/*
 * Playwright E2E config for the Back-In-Stock Waitlist storefront.
 *
 * These specs drive the REAL running PWA in a browser. They exercise what can be
 * verified without real credentials against the shared demo instance:
 *   - the PDP buy-box swap (Add-to-Cart -> Notify Me) via the ?forceOOS=1 helper
 *   - the guest "sign in to be notified" branch and the AuthModal handoff
 * The registered one-tap + submit states are covered by the Jest component test
 * (overrides/app/components/notify-me/index.test.js), since reaching them E2E
 * needs an authenticated account on the instance.
 */
const {defineConfig, devices} = require('@playwright/test')

const PORT = process.env.PORT || 3000
const BASE_URL = `http://localhost:${PORT}`

module.exports = defineConfig({
    testDir: './tests/e2e',
    // PDP first paint proxies through the demo instance, so give it headroom.
    timeout: 60 * 1000,
    expect: {timeout: 15 * 1000},
    fullyParallel: false,
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure'
    },
    projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
    // Reuse the dev server if one is already up (npm start); otherwise start it.
    webServer: {
        command: 'npm start',
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120 * 1000
    }
})
