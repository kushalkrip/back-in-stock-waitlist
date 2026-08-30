/*
 * E2E: the Back-In-Stock "Notify Me" guest flow on a real PDP.
 *
 * Uses the ?forceOOS=1 demo helper so we can preview the out-of-stock buy-box on
 * any product without waiting for a genuinely OOS SKU on the demo instance.
 * As an unauthenticated shopper the component must render the REGISTERED-ONLY
 * guest branch: a "sign in to be notified" prompt with NO email input, and the
 * button must open the AuthModal.
 */
const {test, expect} = require('@playwright/test')

// A standard RefArch variation product (not a set/bundle, which the component
// intentionally skips). `forceOOS=1` forces the Notify Me buy-box.
const OOS_PDP = '/product/25592590M?color=JJV02XX&forceOOS=1'

test.describe('Notify Me — guest flow', () => {
    test('forced-OOS PDP shows the guest sign-in prompt, not an email field', async ({
        page
    }) => {
        await page.goto(OOS_PDP)

        // The PDP shell renders first...
        await expect(page.getByTestId('product-view')).toBeVisible()

        // ...then, once the guest SLAS session bootstraps, the identity skeleton
        // resolves to the guest branch. (The PDP mounts the buy-box in two
        // layouts — main + sticky — so each notify testid matches twice; we
        // assert on the first mounted instance.)
        const guestBox = page.getByTestId('notify-me-guest').first()
        await expect(guestBox).toBeVisible()

        // The one-and-only CTA is "sign in to be notified".
        await expect(page.getByTestId('notify-me-signin').first()).toBeVisible()

        // Registered-only design: the guest is never shown an email input.
        await expect(guestBox.locator('input[type="email"]')).toHaveCount(0)
        await expect(guestBox.getByRole('textbox')).toHaveCount(0)

        // And the registered one-tap submit must NOT be present for a guest.
        await expect(page.getByTestId('notify-me-submit')).toHaveCount(0)
    })

    test('clicking the sign-in prompt opens the auth modal', async ({page}) => {
        await page.goto(OOS_PDP)
        const signin = page.getByTestId('notify-me-signin').first()
        await expect(signin).toBeVisible()

        await signin.click()

        // The AuthModal is a dialog; the login view shows a password field. A
        // visible password input is a reliable signal the login modal opened.
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await expect(dialog.locator('input[type="password"]')).toBeVisible()
    })
})
