/*
 * Tests for the Back-In-Stock ProductView wrapper.
 *
 * This override does NOT fork the ~1050-line base ProductView — it wraps it and,
 * only when the shopper has resolved a concrete orderable-but-unavailable unit,
 * (a) drops addToCart/updateCart so the base omits its disabled cart button and
 * (b) injects NotifyMeForm through the base's `customButtons` slot. So the unit
 * we assert on is: WHICH props reach the (mocked) base. We stub the base,
 * useDerivedProduct, useLocation and NotifyMeForm and read the captured props.
 */
import React from 'react'
import '@testing-library/jest-dom'
import {render} from '@testing-library/react'
import ProductView from './index'

// Capture the props the wrapper forwards to the base component.
let baseProps
jest.mock('@salesforce/retail-react-app/app/components/product-view', () => {
    const React2 = require('react')
    return {
        __esModule: true,
        default: React2.forwardRef((props, ref) => {
            baseProps = props
            return React2.createElement('div', {'data-testid': 'base-product-view', ref})
        })
    }
})

// Control the base derivation (isOutOfStock / variant / showLoading).
const mockUseDerivedProduct = jest.fn()
jest.mock('@salesforce/retail-react-app/app/hooks', () => ({
    useDerivedProduct: (...args) => mockUseDerivedProduct(...args)
}))

// NotifyMeForm is exercised in its own suite; here it's an identifiable marker.
jest.mock('../notify-me', () => ({
    __esModule: true,
    default: (props) => {
        const React2 = require('react')
        return React2.createElement('div', {'data-testid': 'notify-me', 'data-sku': props.sku})
    }
}))

// react-router: control the ?forceOOS query.
let mockSearch = ''
jest.mock('react-router-dom', () => ({
    useLocation: () => ({search: mockSearch})
}))

// react-intl: only intl.locale is read.
jest.mock('react-intl', () => ({
    useIntl: () => ({locale: 'en-US'})
}))

const VARIANT_PRODUCT = {
    id: 'MASTER-1',
    variationAttributes: [{id: 'color'}],
    type: {}
}

const noopHandlers = {addToCart: jest.fn(), updateCart: jest.fn()}

beforeEach(() => {
    jest.clearAllMocks()
    baseProps = undefined
    mockSearch = ''
    // Default: a resolved, in-stock variant → wrapper is a pure passthrough.
    mockUseDerivedProduct.mockReturnValue({
        showLoading: false,
        variant: {productId: 'SKU-1'},
        isOutOfStock: false
    })
})

describe('ProductView wrapper — passthrough', () => {
    test('forwards props untouched (incl. cart handlers) when the unit is in stock', () => {
        render(<ProductView product={VARIANT_PRODUCT} {...noopHandlers} />)
        expect(baseProps.addToCart).toBe(noopHandlers.addToCart)
        expect(baseProps.updateCart).toBe(noopHandlers.updateCart)
        // No Notify Me injected on the in-stock path.
        const injected = baseProps.customButtons || []
        expect(injected).toHaveLength(0)
    })

    test('passes through while the product is still loading (never flashes Notify Me)', () => {
        mockUseDerivedProduct.mockReturnValue({showLoading: true, variant: undefined, isOutOfStock: true})
        render(<ProductView product={VARIANT_PRODUCT} {...noopHandlers} />)
        expect(baseProps.addToCart).toBe(noopHandlers.addToCart)
        expect(baseProps.customButtons).toBeUndefined()
    })

    test('passes through for a product SET even if flagged out of stock', () => {
        mockUseDerivedProduct.mockReturnValue({showLoading: false, variant: {productId: 'SKU-1'}, isOutOfStock: true})
        render(<ProductView product={{...VARIANT_PRODUCT, type: {set: true}}} {...noopHandlers} />)
        expect(baseProps.addToCart).toBe(noopHandlers.addToCart)
    })

    test('passes through for a BUNDLE even if flagged out of stock', () => {
        mockUseDerivedProduct.mockReturnValue({showLoading: false, variant: {productId: 'SKU-1'}, isOutOfStock: true})
        render(<ProductView product={{...VARIANT_PRODUCT, type: {bundle: true}}} {...noopHandlers} />)
        expect(baseProps.addToCart).toBe(noopHandlers.addToCart)
    })

    test('passes through when a variant is NOT yet resolved on a variation master', () => {
        // Out of stock but no concrete variant chosen → don't offer Notify Me yet.
        mockUseDerivedProduct.mockReturnValue({showLoading: false, variant: undefined, isOutOfStock: true})
        render(<ProductView product={VARIANT_PRODUCT} {...noopHandlers} />)
        expect(baseProps.addToCart).toBe(noopHandlers.addToCart)
        expect(baseProps.customButtons).toBeUndefined()
    })
})

describe('ProductView wrapper — Notify Me swap', () => {
    test('drops cart handlers and injects NotifyMeForm for a resolved OOS variant', () => {
        mockUseDerivedProduct.mockReturnValue({
            showLoading: false,
            variant: {productId: 'SKU-1'},
            isOutOfStock: true
        })
        render(<ProductView product={VARIANT_PRODUCT} {...noopHandlers} />)

        // Cart button suppressed: base receives neither handler.
        expect(baseProps.addToCart).toBeUndefined()
        expect(baseProps.updateCart).toBeUndefined()
        // Notify Me injected via the supported customButtons slot, keyed to the SKU.
        expect(baseProps.customButtons).toHaveLength(1)
        expect(baseProps.customButtons[0].props.sku).toBe('SKU-1')
    })

    test('forceOOS=1 in the URL previews Notify Me on an in-stock product', () => {
        mockSearch = '?forceOOS=1'
        // In stock, but the demo query forces the swap.
        mockUseDerivedProduct.mockReturnValue({
            showLoading: false,
            variant: {productId: 'SKU-1'},
            isOutOfStock: false
        })
        render(<ProductView product={VARIANT_PRODUCT} {...noopHandlers} />)
        expect(baseProps.addToCart).toBeUndefined()
        expect(baseProps.customButtons[0].props.sku).toBe('SKU-1')
    })

    test('uses the product id as the SKU for a no-variation product', () => {
        mockUseDerivedProduct.mockReturnValue({showLoading: false, variant: undefined, isOutOfStock: true})
        const simple = {id: 'SIMPLE-1', variationAttributes: [], type: {}}
        render(<ProductView product={simple} {...noopHandlers} />)
        // variantResolved is true when there are no variations → swap happens.
        expect(baseProps.customButtons[0].props.sku).toBe('SIMPLE-1')
    })

    test('preserves any pre-existing customButtons and appends Notify Me after them', () => {
        mockUseDerivedProduct.mockReturnValue({showLoading: false, variant: {productId: 'SKU-1'}, isOutOfStock: true})
        const existing = <button key="existing">x</button>
        render(<ProductView product={VARIANT_PRODUCT} customButtons={[existing]} {...noopHandlers} />)
        expect(baseProps.customButtons).toHaveLength(2)
        expect(baseProps.customButtons[1].props.sku).toBe('SKU-1')
    })

    test('offers Notify Me at the master level when EVERY variant is unorderable', () => {
        // Wholly sold-out master, no variant resolved. Notify Me is keyed to the
        // master id so the shopper is not dead-ended by the greyed dropdown.
        mockUseDerivedProduct.mockReturnValue({showLoading: false, variant: undefined, isOutOfStock: true})
        const master = {
            id: 'MASTER-1',
            variationAttributes: [{id: 'size'}],
            type: {master: true},
            variants: [{productId: 'V-1', orderable: false}, {productId: 'V-2', orderable: false}]
        }
        render(<ProductView product={master} {...noopHandlers} />)
        expect(baseProps.addToCart).toBeUndefined()
        expect(baseProps.customButtons[0].props.sku).toBe('MASTER-1')
    })

    test('does NOT offer master-level Notify Me while some variant is still orderable', () => {
        // Some sizes in stock + none selected → let the shopper pick, no swap.
        mockUseDerivedProduct.mockReturnValue({showLoading: false, variant: undefined, isOutOfStock: true})
        const master = {
            id: 'MASTER-1',
            variationAttributes: [{id: 'size'}],
            type: {master: true},
            variants: [{productId: 'V-1', orderable: false}, {productId: 'V-2', orderable: true}]
        }
        render(<ProductView product={master} {...noopHandlers} />)
        expect(baseProps.addToCart).toBe(noopHandlers.addToCart)
        expect(baseProps.customButtons).toBeUndefined()
    })
})
