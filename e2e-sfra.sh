#!/usr/bin/env bash
#
# Live end-to-end test of the Back-In-Stock waitlist on the REAL SFRA storefront
# (sandbox zzft-025, site RefArch). Exercises the true storefront path:
#
#   login → CSRF token → WaitList-Subscribe → WaitList-Status         (subcommand: subscribe)
#   trigger the reconciliation job via OCAPI                          (subcommand: notify)
#   confirm the outbound webhook actually fired with the right payload (subcommand: verify)
#
# Secrets never live in this file:
#   - SFRA_TEST_PW    (required for `subscribe`) — storefront password for the test shopper.
#                     Pass it inline so it stays in YOUR shell: `SFRA_TEST_PW='…' ./e2e-sfra.sh subscribe`
#   - OCAPI client id/secret (for `notify`) read from ./.ocapi.json (gitignored).
#
# Usage:
#   SKU=25518360M SFRA_TEST_PW='…' ./e2e-sfra.sh subscribe
#   ./e2e-sfra.sh notify           # OCAPI job trigger (needs valid .ocapi.json creds)
#   SKU=25518360M ./e2e-sfra.sh verify
#   SKU=25518360M SFRA_TEST_PW='…' ./e2e-sfra.sh all
#
set -euo pipefail

# ── Config (override via env) ────────────────────────────────────────────────
STORE_HOST="${STORE_HOST:-zzft-025.my.commercecloud.salesforce.com}"
DX_HOST="${DX_HOST:-zzft-025.dx.commercecloud.salesforce.com}"
SITE="${SITE:-RefArch}"
LOCALE="${LOCALE:-en_US}"
EMAIL="${SFRA_TEST_EMAIL:-waitlist.tester@example.com}"
SKU="${SKU:-25518360M}"
JOB_ID="${JOB_ID:-WaitlistNotifyRefArch}"
# Your webhook.site inbox UUID — set via env, e.g. WEBHOOK_TOKEN=xxxxxxxx-... (only used by `poll`).
WEBHOOK_TOKEN="${WEBHOOK_TOKEN:-REPLACE-WITH-YOUR-WEBHOOK-SITE-UUID}"
BASE="https://${STORE_HOST}/on/demandware.store/Sites-${SITE}-Site/${LOCALE}"
JAR="$(mktemp -t wljar.XXXXXX)"
CURL=(/usr/bin/curl -sS --max-time 60)
trap 'rm -f "$JAR"' EXIT

scrape_csrf() { grep -oE 'name="csrf_token"[^>]*value="[^"]+"' | head -1 | sed -E 's/.*value="([^"]+)".*/\1/'; }
json_get()   { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))" 2>/dev/null; }

pdp_available() { # print live availability of $SKU (no auth) — warns if OOS
  "${CURL[@]}" "${BASE}/Product-Variation?pid=${SKU}" -H 'X-Requested-With: XMLHttpRequest' \
    | python3 -c "import sys,json
try:
  p=json.load(sys.stdin).get('product',{}); print('available=%s readyToOrder=%s'%(p.get('available'),p.get('readyToOrder')))
except Exception: print('available=? (not a variation payload — check the PDP)')" 2>/dev/null || true
}

login() {
  [ -n "${SFRA_TEST_PW:-}" ] || { echo "ERROR: set SFRA_TEST_PW (storefront password for $EMAIL)"; exit 2; }
  echo "→ login as $EMAIL"
  local tok
  tok="$("${CURL[@]}" -c "$JAR" "${BASE}/Login-Show" | scrape_csrf)"
  [ -n "$tok" ] || { echo "ERROR: no login CSRF token from Login-Show"; exit 3; }
  "${CURL[@]}" -b "$JAR" -c "$JAR" -o /dev/null \
    --data-urlencode "loginEmail=${EMAIL}" \
    --data-urlencode "loginPassword=${SFRA_TEST_PW}" \
    --data-urlencode "csrf_token=${tok}" \
    -H 'X-Requested-With: XMLHttpRequest' \
    "${BASE}/Account-Login"
  grep -q dwsid "$JAR" || { echo "ERROR: login did not set a session cookie (bad credentials?)"; exit 4; }
  echo "  ✓ session established"
}

wl_token() { # login-gated cache-safe CSRF route → {tokenName, token}
  "${CURL[@]}" -b "$JAR" "${BASE}/WaitList-Token" -H 'X-Requested-With: XMLHttpRequest'
}

cmd_subscribe() {
  echo "== SUBSCRIBE  sku=$SKU =="
  echo "→ live availability: $(pdp_available)"
  login
  local tj tn tv
  tj="$(wl_token)"; tn="$(printf '%s' "$tj" | json_get tokenName)"; tv="$(printf '%s' "$tj" | json_get token)"
  [ -n "$tv" ] || { echo "ERROR: no CSRF token from WaitList-Token (still anonymous?)"; echo "$tj"; exit 5; }
  echo "→ POST WaitList-Subscribe (1st)"
  "${CURL[@]}" -b "$JAR" -H 'X-Requested-With: XMLHttpRequest' \
    --data-urlencode "sku=${SKU}" --data-urlencode "${tn}=${tv}" \
    "${BASE}/WaitList-Subscribe"; echo
  echo "→ POST WaitList-Subscribe (2nd — expect already-subscribed / idempotent)"
  tj="$(wl_token)"; tv="$(printf '%s' "$tj" | json_get token)"
  "${CURL[@]}" -b "$JAR" -H 'X-Requested-With: XMLHttpRequest' \
    --data-urlencode "sku=${SKU}" --data-urlencode "${tn}=${tv}" \
    "${BASE}/WaitList-Subscribe"; echo
  echo "→ GET WaitList-Status (expect subscribed:true)"
  "${CURL[@]}" -b "$JAR" "${BASE}/WaitList-Status?sku=${SKU}" -H 'X-Requested-With: XMLHttpRequest'; echo
}

ocapi_token() {
  local cid csec
  cid="$(python3 -c "import json;print(json.load(open('.ocapi.json'))['clientId'])")"
  csec="$(python3 -c "import json;print(json.load(open('.ocapi.json'))['clientSecret'])")"
  "${CURL[@]}" -u "${cid}:${csec}" -d grant_type=client_credentials \
    "https://account.demandware.com/dwsso/oauth2/access_token" | json_get access_token
}

cmd_notify() {
  echo "== NOTIFY  (trigger job $JOB_ID via OCAPI) =="
  local t; t="$(ocapi_token)"
  [ -n "$t" ] || { echo "ERROR: OCAPI token mint failed (refresh .ocapi.json creds, or run the job from BM:"; \
                   echo "       Administration → Operations → Jobs → $JOB_ID → Run)"; exit 6; }
  local exec_id
  exec_id="$("${CURL[@]}" -X POST -H "Authorization: Bearer $t" -H 'Content-Type: application/json' -d '{}' \
    "https://${DX_HOST}/s/-/dw/data/v23_2/jobs/${JOB_ID}/executions" | json_get id)"
  [ -n "$exec_id" ] || { echo "ERROR: job did not start (is $JOB_ID deployed + step-type registered?)"; exit 7; }
  echo "→ started execution $exec_id — polling…"
  for _ in $(seq 1 30); do
    sleep 4
    local st; st="$("${CURL[@]}" -H "Authorization: Bearer $t" \
      "https://${DX_HOST}/s/-/dw/data/v23_2/jobs/${JOB_ID}/executions/${exec_id}")"
    local status; status="$(printf '%s' "$st" | json_get execution_status)"
    echo "  status=$status"
    [ "$status" = "finished" ] && { printf '%s' "$st" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  exit:',d.get('exit_status',{}).get('status'))" 2>/dev/null; break; }
  done
}

cmd_verify() {
  echo "== VERIFY  (webhook sink got the notification for $SKU) =="
  "${CURL[@]}" "https://webhook.site/token/${WEBHOOK_TOKEN}/requests?sorting=newest&per_page=5" \
    | python3 -c "import sys,json
d=json.load(sys.stdin); reqs=d.get('data',[])
print('sink total:',d.get('total'))
hit=None
for r in reqs:
    c=r.get('content','') or ''
    if '$SKU' in c: hit=r; break
if hit:
    print('  ✓ delivery found at',hit.get('created_at'));
    try: print('  payload:',json.dumps(json.loads(hit['content'])))
    except Exception: print('  payload:',hit.get('content'))
else:
    print('  ✗ no delivery containing $SKU in the last 5 requests (run notify, and confirm the SKU is IN STOCK + service is LIVE not mock)')"
}

case "${1:-}" in
  subscribe) cmd_subscribe ;;
  notify)    cmd_notify ;;
  verify)    cmd_verify ;;
  all)       cmd_subscribe; echo; cmd_notify; echo; cmd_verify ;;
  *) echo "usage: $0 {subscribe|notify|verify|all}   (env: SKU, SFRA_TEST_PW, …)"; exit 1 ;;
esac
