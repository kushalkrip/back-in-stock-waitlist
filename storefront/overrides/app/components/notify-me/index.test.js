/*
 * Tests for the registered-users-only Back-In-Stock NotifyMeForm.
 *
 * The component has three identity branches (skeleton / guest / registered) and,
 * for the registered branch, sub-states: checking / idle / sending / done /
 * already / error. On mount the registered branch runs a STATUS CHECK (is this
 * shopper already on the list for this SKU?) before showing an actionable
 * button — so most registered assertions await the resolved state rather than
 * reading synchronously. We mock the customer + auth hooks so each branch can be
 * driven deterministically, and render through a minimal Intl + Chakra wrapper.
 */
import React from 'react'
import '@testing-library/jest-dom'
import {render, fireEvent, waitFor} from '@testing-library/react'
import {IntlProvider} from 'react-intl'
import {ChakraProvider} from '@chakra-ui/react'
import NotifyMeForm from './index'

// Minimal render wrapper: the component only needs Intl (useIntl) + Chakra
// (Box/Button/Skeleton) context. We deliberately avoid retail-react-app's
// renderWithProviders because its provider tree pulls in a broken Page Designer
// import chain unrelated to this component; all data hooks are mocked below.
const renderNotify = (props) =>
    render(
        <IntlProvider
            locale="en-US"
            messages={{}}
            defaultLocale="en-US"
            onError={() => {} /* silence expected missing-translation warnings */}
        >
            <ChakraProvider>
                <NotifyMeForm {...props} />
            </ChakraProvider>
        </IntlProvider>
    )

// ── Hook mocks ──────────────────────────────────────────────────────────────
const mockUseCurrentCustomer = jest.fn()
const mockOnOpen = jest.fn()
const mockOnClose = jest.fn()

jest.mock('@salesforce/retail-react-app/app/hooks/use-current-customer', () => ({
    useCurrentCustomer: () => mockUseCurrentCustomer()
}))

jest.mock('@salesforce/retail-react-app/app/hooks/use-auth-modal', () => ({
    useAuthModal: () => ({isOpen: false, onOpen: mockOnOpen, onClose: mockOnClose}),
    // Render nothing for the modal itself; we only assert the trigger behaviour.
    AuthModal: () => null
}))

// commerce-sdk-react hooks are only exercised on the LIVE path; stub them so the
// module imports cleanly. fetch is stubbed per-test where the live path is used.
jest.mock('@salesforce/commerce-sdk-react', () => ({
    useAccessToken: () => ({getTokenWhenReady: jest.fn().mockResolvedValue('tok')}),
    useCommerceApi: () => ({
        shopperProducts: {
            clientConfig: {
                parameters: {shortCode: 'sc', organizationId: 'org', siteId: 'site'}
            }
        }
    })
}))

const registered = (email = 'shopper@example.com') => ({
    data: {customerType: 'registered', isRegistered: true, isGuest: false, email}
})
const guest = () => ({
    data: {customerType: 'guest', isRegistered: false, isGuest: true}
})
const bootstrapping = () => ({data: {}}) // customerType undefined

beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.WAITLIST_LIVE // default -> MOCK_MODE
    window.localStorage.clear() // no prior mock "subscription"
})

describe('NotifyMeForm identity branches', () => {
    test('renders a skeleton while the session identity is still unknown', () => {
        mockUseCurrentCustomer.mockReturnValue(bootstrapping())
        const {getByTestId, queryByTestId} = renderNotify({sku: 'SKU-1', locale: 'en-US'})
        expect(getByTestId('notify-me-skeleton')).toBeInTheDocument()
        // Must never flash the guest or registered branch before identity resolves.
        expect(queryByTestId('notify-me-guest')).not.toBeInTheDocument()
        expect(queryByTestId('notify-me-registered')).not.toBeInTheDocument()
    })

    test('guest sees a sign-in prompt and no email input', () => {
        mockUseCurrentCustomer.mockReturnValue(guest())
        const {getByTestId, queryByRole} = renderNotify({sku: 'SKU-1', locale: 'en-US'})
        expect(getByTestId('notify-me-guest')).toBeInTheDocument()
        expect(getByTestId('notify-me-signin')).toBeInTheDocument()
        // Registered-only design: there is no email text input anywhere.
        expect(queryByRole('textbox')).not.toBeInTheDocument()
    })

    test('clicking the guest sign-in button opens the auth modal', () => {
        mockUseCurrentCustomer.mockReturnValue(guest())
        const {getByTestId} = renderNotify({sku: 'SKU-1', locale: 'en-US'})
        fireEvent.click(getByTestId('notify-me-signin'))
        expect(mockOnOpen).toHaveBeenCalledTimes(1)
    })

    test('registered shopper (not yet subscribed) sees one-tap submit and their email, no input', async () => {
        mockUseCurrentCustomer.mockReturnValue(registered('kushal@example.com'))
        const {findByTestId, getByTestId, queryByRole} = renderNotify({
            sku: 'SKU-1',
            locale: 'en-US'
        })
        // Status check resolves "not subscribed" -> the actionable branch.
        expect(await findByTestId('notify-me-registered')).toBeInTheDocument()
        expect(getByTestId('notify-me-submit')).toBeInTheDocument()
        expect(getByTestId('notify-me-silent-notice')).toHaveTextContent('kushal@example.com')
        expect(queryByRole('textbox')).not.toBeInTheDocument()
    })
})

describe('NotifyMeForm already-subscribed status', () => {
    test('a shopper already on the list (mock persistence) sees a passive confirmation, no button', async () => {
        // Pre-seed the mock "subscription" the same way a prior submit would.
        window.localStorage.setItem('waitlist:shopper@example.com:SKU-1', '1')
        mockUseCurrentCustomer.mockReturnValue(registered())
        const {findByTestId, queryByTestId} = renderNotify({sku: 'SKU-1', locale: 'en-US'})

        expect(await findByTestId('notify-me-already')).toBeInTheDocument()
        // No actionable button — the shopper cannot re-subscribe (no duplicate row).
        expect(queryByTestId('notify-me-submit')).not.toBeInTheDocument()
    })

    test('live status GET reporting subscribed lands in the already state (no body, sku in query)', async () => {
        process.env.WAITLIST_LIVE = 'true' // force the live path
        mockUseCurrentCustomer.mockReturnValue(registered())
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({subscribed: true, sku: 'SKU-1'})
        })

        const {findByTestId} = renderNotify({sku: 'SKU-1', locale: 'en-US'})
        expect(await findByTestId('notify-me-already')).toBeInTheDocument()

        // The status check is a GET with the sku in the query string and no body.
        expect(global.fetch).toHaveBeenCalledTimes(1)
        const [url, opts] = global.fetch.mock.calls[0]
        expect(url).toContain('sku=SKU-1')
        // No method === defaults to GET; and definitely no request body.
        expect(opts.method).toBeUndefined()
        expect(opts.body).toBeUndefined()
    })
})

describe('NotifyMeForm submit states', () => {
    test('successful (mock) submit transitions to the confirmation state and persists', async () => {
        mockUseCurrentCustomer.mockReturnValue(registered())
        const {findByTestId} = renderNotify({sku: 'SKU-1', locale: 'en-US'})
        // Wait past the status-check skeleton to the actionable button.
        fireEvent.click(await findByTestId('notify-me-submit'))
        // submitMock resolves after a short delay -> done branch.
        expect(await findByTestId('notify-me-done', {}, {timeout: 3000})).toBeInTheDocument()
        // Persisted so a refresh would land in `already`.
        expect(window.localStorage.getItem('waitlist:shopper@example.com:SKU-1')).toBe('1')
    })

    test('a failed live submit surfaces an accessible error', async () => {
        process.env.WAITLIST_LIVE = 'true' // force the live path
        mockUseCurrentCustomer.mockReturnValue(registered())
        // First fetch = status check (not subscribed); second = the failing POST.
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({subscribed: false})
            })
            .mockResolvedValueOnce({ok: false})

        const {findByTestId, getByTestId} = renderNotify({sku: 'SKU-1', locale: 'en-US'})
        fireEvent.click(await findByTestId('notify-me-submit'))

        const error = await findByTestId('notify-me-error', {}, {timeout: 3000})
        expect(error).toBeInTheDocument()
        // The submit button points at the error via aria-describedby for a11y.
        await waitFor(() =>
            expect(getByTestId('notify-me-submit')).toHaveAttribute(
                'aria-describedby',
                'notify-me-error'
            )
        )
        // The POST payload must NOT contain an email (server derives it).
        const postCall = global.fetch.mock.calls[1]
        expect(postCall[1].method).toBe('POST')
        const body = JSON.parse(postCall[1].body)
        expect(body).toEqual({sku: 'SKU-1', locale: 'en-US'})
    })
})
