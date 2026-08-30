import React, {useEffect, useState} from 'react'
import PropTypes from 'prop-types'
import {useIntl} from 'react-intl'
import {useAccessToken, useCommerceApi} from '@salesforce/commerce-sdk-react'
import {useCurrentCustomer} from '@salesforce/retail-react-app/app/hooks/use-current-customer'
import {AuthModal, useAuthModal} from '@salesforce/retail-react-app/app/hooks/use-auth-modal'
import {
    Box,
    Button,
    Skeleton,
    Stack,
    Text
} from '@salesforce/retail-react-app/app/components/shared/ui'

/**
 * NotifyMeForm — REGISTERED-USERS-ONLY back-in-stock signup.
 *
 * Rendered on the PDP in place of Add-to-Cart when the selected variant is not
 * orderable. There is deliberately NO email input: the address is the
 * authenticated account email, resolved server-side from the SLAS token — the
 * client never sends (or is trusted with) an email. See docs/UI-DESIGN.md §3
 * and docs/HLD.md DECISIONS LOCKED #2.
 *
 * Three identity branches (docs/UI-DESIGN.md §2, §6.2):
 *   - identity unknown (session still bootstrapping) → skeleton
 *   - guest                                          → "Sign in to be notified" prompt (opens AuthModal)
 *   - registered                                     → one-tap "Notify me" (no email field)
 *
 * Registered sub-states: checking | idle | sending | done | already | error.
 *   - checking : we ask the server whether this shopper is ALREADY on the list
 *                for this SKU (see status check below) before showing an
 *                actionable button — otherwise a subscribed shopper who
 *                refreshes would see "Notify me" again and could create a
 *                duplicate row.
 *   - already  : subscribed on a PRIOR visit → passive confirmation, no button.
 *   - done     : subscribed just now         → passive confirmation, no button.
 * A POST that returns status "already-subscribed" is treated as success and
 * lands in `already` (idempotent).
 *
 * ── LOCAL DEV ─────────────────────────────────────────────────────────────
 * The custom `/custom/waitlist` endpoint only exists on OUR sandbox (zzft-025),
 * not on the shared demo instance this app currently points at, and calling it
 * live needs a usable SLAS client (blocked — see docs/HLD.md §12). So while
 * developing against demo data we run in MOCK_MODE: submit simulates a
 * successful call and persistence is mirrored in localStorage so the
 * "already subscribed after refresh" behaviour is demoable without a backend.
 * Set WAITLIST_LIVE=true at build time once the endpoint is deployed and a real
 * SLAS client is configured; the component then uses the real GET status +
 * POST subscribe calls instead.
 */
const SCAPI_PATH = 'custom/waitlist/v1'

// `process` is only defined server-side in the PWA Kit bundle; guard it so the
// browser doesn't throw ReferenceError. Evaluated at submit time (not import)
// so the flag can be toggled per environment/test rather than frozen once.
const isMockMode = () => typeof process === 'undefined' || process.env.WAITLIST_LIVE !== 'true'

// Base URL for the subscriptions resource. GET (with &sku=) reads status; POST
// (with an email-free body) creates the subscription.
const subscriptionsUrl = ({shortCode, organizationId, siteId}) =>
    `https://${shortCode}.api.commercecloud.salesforce.com/${SCAPI_PATH}` +
    `/organizations/${organizationId}/subscriptions?siteId=${siteId}`

// ── MOCK persistence ────────────────────────────────────────────────────────
// In MOCK_MODE there is no backend to remember a signup, so we stand in for the
// server-side Custom Object with localStorage keyed by account email + SKU.
// This is ONLY a dev/demo convenience; the live path uses the GET status call.
const mockStorageKey = (email, sku) => `waitlist:${String(email || '').toLowerCase()}:${sku}`

const readMockSubscribed = (email, sku) => {
    if (typeof window === 'undefined' || !window.localStorage) return false
    try {
        return window.localStorage.getItem(mockStorageKey(email, sku)) === '1'
    } catch (e) {
        return false
    }
}

const writeMockSubscribed = (email, sku) => {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
        window.localStorage.setItem(mockStorageKey(email, sku), '1')
    } catch (e) {
        /* storage unavailable (private mode / quota) — non-fatal for a demo */
    }
}

const NotifyMeForm = ({sku, locale}) => {
    const intl = useIntl()
    // Registered flow starts in `checking`: we don't render an actionable button
    // until the status lookup resolves, so a subscribed shopper never sees the
    // one-tap button after a refresh.
    const [state, setState] = useState('checking')
    const {getTokenWhenReady} = useAccessToken()
    const api = useCommerceApi()
    const authModal = useAuthModal()
    const {data: customer} = useCurrentCustomer()

    // `customerType` is undefined only while the shopper session is still
    // bootstrapping; once a (guest or registered) token exists it is a string.
    const identityKnown = Boolean(customer?.customerType)
    const isRegistered = Boolean(customer?.isRegistered)
    // Display-only. The SERVER derives the authoritative address from the token;
    // this is just what we tell the shopper we'll email.
    const displayEmail = customer?.email

    // Telemetry hook points (docs/UI-DESIGN.md §10). Kept as a thin console
    // breadcrumb so the events are observable in dev without wiring a full
    // analytics dependency into a take-home.
    useEffect(() => {
        if (identityKnown && !isRegistered) {
            console.info('[NotifyMe] notify_me_login_prompt_shown', {sku})
        }
    }, [identityKnown, isRegistered, sku])

    // ── Status check ────────────────────────────────────────────────────────
    // For a registered shopper, ask the backend whether they're ALREADY on the
    // list for this SKU before showing anything actionable. Re-runs when the
    // selected variant (sku) changes. Fails OPEN: if we can't determine status
    // we fall back to `idle` so the shopper can still subscribe.
    useEffect(() => {
        if (!identityKnown || !isRegistered) return undefined
        let ignore = false
        setState('checking')

        const resolveStatus = async () => {
            if (isMockMode()) return readMockSubscribed(displayEmail, sku)
            const {shortCode, organizationId, siteId} = api.shopperProducts.clientConfig.parameters
            const token = await getTokenWhenReady()
            const url =
                `${subscriptionsUrl({shortCode, organizationId, siteId})}` +
                `&sku=${encodeURIComponent(sku)}`
            const res = await fetch(url, {headers: {Authorization: `Bearer ${token}`}})
            if (!res.ok) return false
            const data = await res.json()
            return Boolean(data && data.subscribed)
        }

        resolveStatus()
            .then((subscribed) => {
                if (!ignore) setState(subscribed ? 'already' : 'idle')
            })
            .catch(() => {
                if (!ignore) setState('idle')
            })

        return () => {
            ignore = true
        }
        // displayEmail/api/getTokenWhenReady are stable for a given session; we
        // intentionally re-check only on identity resolution and variant change.
    }, [identityKnown, isRegistered, sku])

    const submitLive = async () => {
        // shortCode / organizationId / siteId come from config/default.js.
        const {shortCode, organizationId, siteId} = api.shopperProducts.clientConfig.parameters
        const token = await getTokenWhenReady()
        const res = await fetch(subscriptionsUrl({shortCode, organizationId, siteId}), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            // NO email in the body — the endpoint derives it from the token.
            body: JSON.stringify({sku, locale})
        })
        if (!res.ok) return {ok: false, already: false}
        let already = false
        try {
            const data = await res.json()
            already = Boolean(data && data.status === 'already-subscribed')
        } catch (e) {
            /* a 2xx with an unparseable body is still a successful subscribe */
        }
        return {ok: true, already}
    }

    // Simulates the endpoint locally: resolves ok after a short delay so the
    // sending -> done transition is exercised exactly as in production.
    const submitMock = () =>
        new Promise((resolve) => {
            console.info('[NotifyMe:mock] would POST', {sku, locale})
            setTimeout(() => resolve({ok: true, already: false}), 700)
        })

    const onSubmit = async (e) => {
        if (e && e.preventDefault) e.preventDefault()
        if (state === 'sending') return
        setState('sending')
        try {
            const result = isMockMode() ? await submitMock() : await submitLive()
            if (result.ok) {
                // Persist the mock "subscription" so a refresh lands in `already`.
                if (isMockMode()) writeMockSubscribed(displayEmail, sku)
                setState(result.already ? 'already' : 'done')
            } else {
                setState('error')
            }
        } catch (err) {
            setState('error')
        }
    }

    const title = intl.formatMessage({
        defaultMessage: 'Out of stock',
        id: 'notify_me.title'
    })

    // ── Identity unknown: skeleton (never flash the wrong branch) ───────────
    if (!identityKnown) {
        return (
            <Box
                data-testid="notify-me-skeleton"
                borderWidth="1px"
                borderRadius="base"
                p={4}
                marginBottom={4}
            >
                <Stack spacing={3}>
                    <Skeleton height={5} width="40%" />
                    <Skeleton height={4} width="80%" />
                    <Skeleton height={10} width="100%" />
                </Stack>
            </Box>
        )
    }

    // ── Guest: prompt to sign in (no email input, no continue-as-guest) ─────
    if (!isRegistered) {
        return (
            <Box
                data-testid="notify-me-guest"
                borderWidth="1px"
                borderRadius="base"
                p={4}
                marginBottom={4}
            >
                <Stack spacing={3}>
                    <Text fontWeight="bold">{title}</Text>
                    <Text fontSize="sm">
                        {intl.formatMessage({
                            defaultMessage:
                                'Sign in and we’ll notify you by email the moment this is back in stock.',
                            id: 'notify_me.body_guest_login'
                        })}
                    </Text>
                    <Button
                        data-testid="notify-me-signin"
                        width="100%"
                        onClick={() => {
                            console.info('[NotifyMe] notify_me_login_prompt_signin_clicked', {sku})
                            authModal.onOpen()
                        }}
                    >
                        {intl.formatMessage({
                            defaultMessage: 'Sign in to be notified',
                            id: 'notify_me.signin_cta'
                        })}
                    </Button>
                </Stack>
                {/* On successful login the shopper becomes registered and
                    useCurrentCustomer re-renders this component into the
                    one-tap branch below. */}
                <AuthModal {...authModal} onLoginSuccess={authModal.onClose} />
            </Box>
        )
    }

    // ── Registered, status still loading: skeleton (don't flash the button) ─
    if (state === 'checking') {
        return (
            <Box
                data-testid="notify-me-checking"
                borderWidth="1px"
                borderRadius="base"
                p={4}
                marginBottom={4}
            >
                <Stack spacing={3}>
                    <Skeleton height={5} width="40%" />
                    <Skeleton height={4} width="80%" />
                    <Skeleton height={10} width="100%" />
                </Stack>
            </Box>
        )
    }

    // ── Registered, already on the list (prior visit): passive confirmation ─
    if (state === 'already') {
        return (
            <Box
                data-testid="notify-me-already"
                borderWidth="1px"
                borderRadius="base"
                p={4}
                marginBottom={4}
            >
                <Text fontWeight="bold">
                    {intl.formatMessage({
                        defaultMessage: 'You’re already on the list ✓',
                        id: 'notify_me.already_title'
                    })}
                </Text>
                <Text fontSize="sm">
                    {displayEmail
                        ? intl.formatMessage(
                              {
                                  defaultMessage:
                                      'We’ll email {email} the moment this is back in stock.',
                                  id: 'notify_me.already_body'
                              },
                              {email: displayEmail}
                          )
                        : intl.formatMessage({
                              defaultMessage:
                                  'We’ll email your account address the moment this is back in stock.',
                              id: 'notify_me.already_body_generic'
                          })}
                </Text>
            </Box>
        )
    }

    // ── Registered, submitted just now: confirmation ────────────────────────
    if (state === 'done') {
        return (
            <Box
                data-testid="notify-me-done"
                borderWidth="1px"
                borderRadius="base"
                p={4}
                marginBottom={4}
            >
                <Text fontWeight="bold">
                    {intl.formatMessage({
                        defaultMessage: 'You’re on the list! 🎉',
                        id: 'notify_me.done_title'
                    })}
                </Text>
                <Text fontSize="sm">
                    {displayEmail
                        ? intl.formatMessage(
                              {
                                  defaultMessage:
                                      'We’ll email {email} the moment this is back in stock.',
                                  id: 'notify_me.done_body'
                              },
                              {email: displayEmail}
                          )
                        : intl.formatMessage({
                              defaultMessage:
                                  'We’ll email your account address the moment this is back in stock.',
                              id: 'notify_me.done_body_generic'
                          })}
                </Text>
            </Box>
        )
    }

    // ── Registered, idle/sending/error: one-tap (no email field) ────────────
    return (
        <Box
            data-testid="notify-me-registered"
            borderWidth="1px"
            borderRadius="base"
            p={4}
            marginBottom={4}
        >
            <Stack spacing={3}>
                <Text fontWeight="bold">{title}</Text>
                <Text fontSize="sm" data-testid="notify-me-silent-notice">
                    {displayEmail
                        ? intl.formatMessage(
                              {
                                  defaultMessage: 'We’ll email {email} when this is back in stock.',
                                  id: 'notify_me.silent_email_notice'
                              },
                              {email: displayEmail}
                          )
                        : intl.formatMessage({
                              defaultMessage:
                                  'We’ll email your account address when this is back in stock.',
                              id: 'notify_me.silent_email_notice_generic'
                          })}
                </Text>
                <Button
                    data-testid="notify-me-submit"
                    onClick={onSubmit}
                    isLoading={state === 'sending'}
                    width="100%"
                    {...(state === 'error' && {'aria-describedby': 'notify-me-error'})}
                >
                    {intl.formatMessage({
                        defaultMessage: 'Notify me',
                        id: 'notify_me.submit'
                    })}
                </Button>
                {state === 'error' && (
                    <Text
                        id="notify-me-error"
                        data-testid="notify-me-error"
                        color="red.500"
                        fontSize="sm"
                    >
                        {intl.formatMessage({
                            defaultMessage: 'Something went wrong. Please try again.',
                            id: 'notify_me.error'
                        })}
                    </Text>
                )}
            </Stack>
        </Box>
    )
}

NotifyMeForm.propTypes = {
    /** The currently selected VARIANT product ID (not the master). */
    sku: PropTypes.string.isRequired,
    /** Shopper locale, forwarded to the notification payload. */
    locale: PropTypes.string
}

export default NotifyMeForm
