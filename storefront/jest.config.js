/*
 * Copyright (c) 2024, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('@salesforce/pwa-kit-dev/configs/jest/jest.config.js')

module.exports = {
    ...base,
    // To support extensibility, jest needs to transform the underlying templates/extensions.
    // cc-datacloud-typescript ships ESM only and is pulled in transitively via the provider
    // tree (recommended-products -> use-datacloud), so it must be transformed too.
    transformIgnorePatterns: [
        '/node_modules/(?!(@salesforce/retail-react-app|@salesforce/cc-datacloud-typescript)/.*)'
    ],
    // Playwright E2E specs live under tests/e2e and use @playwright/test — they
    // are run by `npm run test:e2e`, NOT Jest. Without this, Jest's default
    // testMatch picks up the .spec.js file and the suite fails to load.
    testPathIgnorePatterns: [...(base.testPathIgnorePatterns || []), '/tests/e2e/'],
    moduleNameMapper: {
        ...base.moduleNameMapper,
        // pulled from @salesforce/retail-react-app jest.config.js
        // allows jest to resolve imports for these packages
        '^is-what$': '<rootDir>/node_modules/is-what/dist/cjs/index.cjs',
        '^copy-anything$': '<rootDir>/node_modules/copy-anything/dist/cjs/index.cjs'
    }
}
