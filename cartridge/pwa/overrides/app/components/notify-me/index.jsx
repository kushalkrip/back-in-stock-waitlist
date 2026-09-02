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
 *   - checking : brief one-tick pre-paint state while we read the LOCAL
 *                already-subscribed hint (synchronous localStorage, NO network)
 *                — so a subscribed shopper who refreshes doesn't flash the
 *                "Notify me" button.
 *   - already  : subscribed on a PRIOR visit (per the local hint) → passive
 *                confirmation, no button.
 *   - done     : subscribed just now → passive confirmation, no button.
 *
 * We deliberately do NOT read subscription status from the server on PDP load.
 * The backend write is idempotent (dedupe on a deterministic sha256(email|sku)
 * key + query-before-insert), so a re-click is harmless — spending an
 * authenticated round-trip on the most performance-sensitive page to prevent a
 * harmless re-click isn't worth the latency (see docs/UI-DESIGN.md LOCKED #4).
 * A POST that returns status "already-subscribed" is treated as success and
 * lands in `already`. An authoritative/cross-device status read (GET
 * getWaitlistStatus) exists for an account "my waitlist" view, but is
 * intentionally kept OFF the PDP critical path.
 *
 * ── LOCAL DEV ─────────────────────────────────────────────────────────────
 * The custom `/custom/waitlist` endpoint only exists on OUR sandbox (zzft-025),
 * not on the shared demo instance this app currently points at, and calling it
 * live needs a usable SLAS client (blocked — see docs/HLD.md §12). So while
 * developing against demo data we run in MOCK_MODE: submit simulates a
 * successful call. In BOTH modes the "already subscribed after refresh"
 * behaviour is driven by the local hint in localStorage (written on a
 * successful submit); the only difference is whether submit hits the real POST
 * endpoint. Set WAITLIST_LIVE=true at build time once the endpoint is deployed
 * and a real SLAS client is configured; the component then uses the real POST
 * subscribe call.
 */
const SCAPI_PATH = 'custom/waitlist/v1'

// `process` is only defined server-side in the PWA Kit bundle; guard it so the
// browser doesn't throw ReferenceError. Evaluated at submit time (not import)
// so the flag can be toggled per environment/test rather than frozen once.
const isMockMode = () => typeof process === 'undefined' || process.env.WAITLIST_LIVE !== 'true'

// Base URL for the subscriptions resource. POST (with an email-free body)
// creates the subscription; the server derives the email from the token.
//
// We route through the PWA Kit proxy (`proxyBase` = `<origin>/mobify/proxy/api`,
// mapped to the SCAPI host by `proxyConfigs` in config/default.js) rather than
// hitting `https://<shortCode>.api.commercecloud.salesforce.com` directly. A
// direct cross-origin call is blocked twice over: the browser's Content Security
// Policy `connect-src` allowlist does not include the SCAPI host (only `'self'`),
// and SCAPI would reject the cross-origin request at CORS. Going through the
// same-origin proxy — exactly how commerce-sdk-react makes its own Shopper API
// calls — sidesteps both. The proxy forwards the Authorization bearer header.
const subscriptionsUrl = ({proxyBase, organizationId, siteId}) =>
    `${proxyBase}/${SCAPI_PATH}` +
    `/organizations/${organizationId}/subscriptions?siteId=${siteId}`

// ── Local "already subscribed" hint ──────────────────────────────────────────
// A client-side breadcrumb (localStorage, keyed by account email + SKU) written
// on a successful submit and read on mount, so a refresh shows the passive
// "already on the list" state WITHOUT a network round-trip. It is a UX nicety,
// NOT the source of truth — the backend dedupes idempotently, so a missing or
// stale hint just means the shopper sees the one-tap button again and a
// re-click no-ops server-side. Used in BOTH mock and live modes.
const subscribedHintKey = (email, sku) => `waitlist:${String(email || '').toLowerCase()}:${sku}`

const readSubscribedHint = (email, sku) => {
    if (typeof window === 'undefined' || !window.localStorage) return false
    try {
        return window.localStorage.getItem(subscribedHintKey(email, sku)) === '1'
    } catch (e) {
        return false
    }
}

const writeSubscribedHint = (email, sku) => {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
        window.localStorage.setItem(subscribedHintKey(email, sku), '1')
    } catch (e) {
        /* storage unavailable (private mode / quota) — non-fatal for a demo */
    }
}

const NotifyMeForm = ({sku, locale}) => {
    const intl = useIntl()
    // Registered flow starts in `checking`: a one-tick pre-paint state while we
    // read the LOCAL already-subscribed hint, so a subscribed shopper never
    // flashes the one-tap button after a refresh. No network is involved.
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

    // ── Already-subscribed hint (client-side, no network) ────────────────────
    // See the header note: we do NOT read server status on PDP load. Once
    // identity resolves we read the LOCAL hint synchronously and either show the
    // passive `already` state or fall through to the one-tap button. Re-runs
    // when the selected variant (sku) changes.
    useEffect(() => {
        if (!identityKnown || !isRegistered) return
        setState(readSubscribedHint(displayEmail, sku) ? 'already' : 'idle')
    }, [identityKnown, isRegistered, sku, displayEmail])

    const submitLive = async () => {
        // organizationId / siteId come from config/default.js; `proxy` is the
        // same-origin proxy base commerce-sdk-react resolves at runtime
        // (`<origin>/mobify/proxy/api`). Fall back to the well-known proxyPath if
        // the SDK hasn't populated it (e.g. under test).
        const {parameters, proxy} = api.shopperProducts.clientConfig
        const {organizationId, siteId} = parameters
        const proxyBase = proxy || '/mobify/proxy/api'
        const token = await getTokenWhenReady()
        const res = await fetch(subscriptionsUrl({proxyBase, organizationId, siteId}), {
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
                // Persist the local hint so a refresh lands in `already`.
                writeSubscribedHint(displayEmail, sku)
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
