/*
 * Copyright (c) 2023, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/**
 * BACK-IN-STOCK: thin wrapper around the base retail-react-app ProductView.
 *
 * This override deliberately does NOT fork the ~1050-line base component. PWA
 * Kit's OverridesResolverPlugin resolves an `@salesforce/retail-react-app/...`
 * import made from *inside* the overrides dir to the BASE package (its
 * `isFromExtends` returns false for override-issued requests), so we can import
 * and wrap the very component we are shadowing — no infinite loop. Wrapping
 * instead of copying means we inherit every future base change (pricing,
 * bundles, express checkout, a11y fixes) with zero merge burden.
 *
 * Behaviour (docs/UI-DESIGN.md, DECISIONS LOCKED #1): when the shopper has
 * resolved a concrete, orderable-but-unavailable unit, replace the (disabled)
 * Add-to-Cart button with the Notify Me form. We achieve "replace" with only
 * public seams:
 *   - `useDerivedProduct(product, ...)` — the SAME hook the base component uses
 *     internally, so `isOutOfStock`/`variant` are byte-identical to what the
 *     base would compute; no re-derivation, no guessing.
 *   - Omit `addToCart`/`updateCart` — the base only renders the cart button when
 *     one of these is passed, so dropping them removes it (the base OOS
 *     inventory message still shows).
 *   - `customButtons` — the base's supported slot for injecting extra buy-box
 *     CTAs; we pass NotifyMeForm through it.
 */

import React, {forwardRef} from 'react'
import PropTypes from 'prop-types'
import {useLocation} from 'react-router-dom'
import {useIntl} from 'react-intl'

// Resolves to the BASE ProductView in node_modules (see the header note on the
// resolver), NOT back to this file.
import BaseProductView from '@salesforce/retail-react-app/app/components/product-view'
import {useDerivedProduct} from '@salesforce/retail-react-app/app/hooks'

// Relative import: NotifyMeForm exists only in overrides/, so the
// '@salesforce/retail-react-app/*' alias (which points at node_modules) can't
// find it.
import NotifyMeForm from '../notify-me'

const ProductView = forwardRef((props, ref) => {
    const {
        product,
        isProductPartOfSet = false,
        isProductPartOfBundle = false,
        controlledVariationValues = null
    } = props
    const intl = useIntl()
    const location = useLocation()

    // Same derivation the base component performs internally.
    const {showLoading, variant, isOutOfStock} = useDerivedProduct(
        product,
        isProductPartOfSet,
        isProductPartOfBundle,
        false,
        controlledVariationValues
    )

    const isProductASet = Boolean(product?.type?.set)
    const isProductABundle = Boolean(product?.type?.bundle)
    const hasVariations = product?.variationAttributes?.length > 0
    // The resolved, orderable unit: the chosen variant, or the product itself
    // when it has no variations.
    const selectedSku = variant?.productId || product?.id
    const variantResolved = Boolean(variant?.productId) || !hasVariations

    // Demo helper: append `?forceOOS=1` to any PDP URL to preview the Notify Me
    // state on an in-stock product without having to zero out inventory.
    const forceOOS = new URLSearchParams(location.search).get('forceOOS') === '1'

    const showNotifyMe =
        !showLoading &&
        !isProductASet &&
        !isProductABundle &&
        Boolean(selectedSku) &&
        ((isOutOfStock && variantResolved) || forceOOS)

    if (!showNotifyMe) {
        return <BaseProductView ref={ref} {...props} />
    }

    // Out of stock: drop the cart handlers so the base omits the (disabled)
    // Add-to-Cart / Update button, and surface Notify Me via customButtons.
    // addToCart/updateCart are intentionally destructured out (never forwarded).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {addToCart, updateCart, customButtons = [], ...rest} = props
    return (
        <BaseProductView
            ref={ref}
            {...rest}
            customButtons={[
                ...customButtons,
                <NotifyMeForm key="notify-me" sku={selectedSku} locale={intl.locale} />
            ]}
        />
    )
})

ProductView.displayName = 'ProductView'

ProductView.propTypes = {
    product: PropTypes.object,
    isProductPartOfSet: PropTypes.bool,
    isProductPartOfBundle: PropTypes.bool,
    controlledVariationValues: PropTypes.object,
    addToCart: PropTypes.func,
    updateCart: PropTypes.func,
    customButtons: PropTypes.array
}

export default ProductView
