#!/usr/bin/env bash
# Deploys Aurex to Railway in one command, and is safe to re-run:
#   project -> service -> persistent volume (/data) -> public domain -> variables -> upload & build -> health check.
#
# Requirements: curl, jq, openssl, and the Railway CLI (npm i -g @railway/cli).
# Usage:
#   RAILWAY_API_TOKEN=<account token> ADMIN_EMAILS=you@example.com ./scripts/deploy-railway.sh
# Optional: PROJECT_NAME (default aurex), SERVICE_NAME (default aurex), plus any app variable from
# .env.example (e.g. ANTHROPIC_API_KEY, STRIPE_SECRET_KEY) to set it on the service.
set -euo pipefail

: "${RAILWAY_API_TOKEN:?Set RAILWAY_API_TOKEN to a Railway account token (railway.com/account/tokens, no workspace)}"
PROJECT_NAME="${PROJECT_NAME:-aurex}"
SERVICE_NAME="${SERVICE_NAME:-aurex}"
API="https://backboard.railway.com/graphql/v2"
cd "$(dirname "$0")/.."

gql() {
  local query="$1" vars="${2:-}"
  [ -n "$vars" ] || vars='{}'
  local out
  out=$(jq -nc --arg q "$query" --argjson v "$vars" '{query: $q, variables: $v}' |
    curl -sS "$API" -H "Authorization: Bearer $RAILWAY_API_TOKEN" -H "Content-Type: application/json" --data-binary @-)
  if echo "$out" | jq -e '.errors' >/dev/null 2>&1; then
    echo "Railway API error: $(echo "$out" | jq -r '.errors[0].message')" >&2
    return 1
  fi
  echo "$out"
}

step() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

step "Checking credentials"
gql 'query { me { name } }' | jq -r '"Signed in as " + (.data.me.name // "Railway user")'

step "Project '$PROJECT_NAME'"
PROJECT_ID=$(gql 'query { projects { edges { node { id name } } } }' |
  jq -r --arg n "$PROJECT_NAME" '[.data.projects.edges[].node | select(.name == $n)][0].id // empty')
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(gql 'mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { id } }' \
    "$(jq -nc --arg n "$PROJECT_NAME" '{i: {name: $n, description: "Aurex: payments, AI hub and AI-assisted trading", defaultEnvironmentName: "production"}}')" |
    jq -r '.data.projectCreate.id')
  echo "created $PROJECT_ID"
else
  echo "found $PROJECT_ID"
fi

PROJECT=$(gql 'query($id: String!) { project(id: $id) {
  environments { edges { node { id name } } }
  services { edges { node { id name } } }
  volumes { edges { node { id volumeInstances { edges { node { serviceId mountPath } } } } } } } }' \
  "$(jq -nc --arg id "$PROJECT_ID" '{id: $id}')")
ENV_ID=$(echo "$PROJECT" | jq -r '([.data.project.environments.edges[].node | select(.name == "production")][0] // .data.project.environments.edges[0].node).id')
echo "environment $ENV_ID"

step "Service '$SERVICE_NAME'"
SERVICE_ID=$(echo "$PROJECT" | jq -r --arg n "$SERVICE_NAME" '[.data.project.services.edges[].node | select(.name == $n)][0].id // empty')
if [ -z "$SERVICE_ID" ]; then
  SERVICE_ID=$(gql 'mutation($i: ServiceCreateInput!) { serviceCreate(input: $i) { id } }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg n "$SERVICE_NAME" '{i: {projectId: $p, name: $n}}')" | jq -r '.data.serviceCreate.id')
  echo "created $SERVICE_ID"
else
  echo "found $SERVICE_ID"
fi

step "Persistent volume at /data (keeps the database across deploys)"
HAS_VOLUME=$(echo "$PROJECT" | jq -r --arg s "$SERVICE_ID" '[.data.project.volumes.edges[].node.volumeInstances.edges[].node | select(.serviceId == $s and .mountPath == "/data")] | length')
if [ "$HAS_VOLUME" = "0" ]; then
  gql 'mutation($i: VolumeCreateInput!) { volumeCreate(input: $i) { id } }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENV_ID" --arg s "$SERVICE_ID" '{i: {projectId: $p, environmentId: $e, serviceId: $s, mountPath: "/data"}}')" >/dev/null
  echo "created"
else
  echo "already attached"
fi

step "Public domain"
DOMAINS=$(gql 'query($p: String!, $e: String!, $s: String!) { domains(projectId: $p, environmentId: $e, serviceId: $s) { serviceDomains { domain } customDomains { domain } } }' \
  "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENV_ID" --arg s "$SERVICE_ID" '{p: $p, e: $e, s: $s}')")
DOMAIN=$(echo "$DOMAINS" | jq -r '(.data.domains.customDomains[0].domain // .data.domains.serviceDomains[0].domain) // empty')
if [ -z "$DOMAIN" ]; then
  DOMAIN=$(gql 'mutation($i: ServiceDomainCreateInput!) { serviceDomainCreate(input: $i) { domain } }' \
    "$(jq -nc --arg e "$ENV_ID" --arg s "$SERVICE_ID" '{i: {environmentId: $e, serviceId: $s, targetPort: 4000}}')" | jq -r '.data.serviceDomainCreate.domain')
fi
echo "https://$DOMAIN"

step "Variables"
EXISTING=$(gql 'query($p: String!, $e: String!, $s: String!) { variables(projectId: $p, environmentId: $e, serviceId: $s) }' \
  "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENV_ID" --arg s "$SERVICE_ID" '{p: $p, e: $e, s: $s}')" | jq -c '.data.variables // {}')
# Generate MASTER_KEY once; never rotate it here (that would make stored user keys unreadable).
MASTER_KEY_JSON='{}'
if [ "$(echo "$EXISTING" | jq -r '.MASTER_KEY // empty')" = "" ]; then
  MASTER_KEY_JSON=$(jq -nc --arg k "$(openssl rand -hex 32)" '{MASTER_KEY: $k}')
fi
# Admin rights in production need this code (an email address alone isn't proof). Generated once.
if [ "$(echo "$EXISTING" | jq -r '.ADMIN_SETUP_CODE // empty')" = "" ]; then
  SETUP_CODE="${ADMIN_SETUP_CODE:-$(openssl rand -hex 16)}"
  MASTER_KEY_JSON=$(echo "$MASTER_KEY_JSON" | jq -c --arg c "$SETUP_CODE" '. + {ADMIN_SETUP_CODE: $c}')
  echo "ADMIN_SETUP_CODE: $SETUP_CODE"
  echo "  Keep it secret. After signing up with an ADMIN_EMAILS address and turning on 2FA, enter it under Settings -> Admin access."
fi
VARS=$(jq -nc \
  --arg app "https://$DOMAIN" \
  --arg admins "${ADMIN_EMAILS:-$(echo "$EXISTING" | jq -r '.ADMIN_EMAILS // ""')}" \
  --argjson mk "$MASTER_KEY_JSON" \
  '{NODE_ENV: "production", PORT: "4000", DATABASE_PATH: "/data/aurex.db", TRUST_PROXY: "true",
    APP_URL: $app, ADMIN_EMAILS: $admins, RAILWAY_RUN_UID: "0"} + $mk')
# Pass through any optional app settings present in the caller's environment.
for name in PAYMENT_RAILS STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET P2P_FEE_BPS FX_SPREAD_BPS WITHDRAWAL_FEE_BPS \
  MAX_TX_USD DAILY_LIMIT_USD FX_LIVE ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY MISTRAL_API_KEY GROQ_API_KEY \
  XAI_API_KEY DEEPSEEK_API_KEY OPENROUTER_API_KEY TOGETHER_API_KEY PERPLEXITY_API_KEY AI_DEFAULT_MODEL \
  ALPACA_DATA_KEY_ID ALPACA_DATA_SECRET_KEY ALLOW_LIVE_TRADING AI_MAX_POSITION_PCT AI_FREE_DAILY_REQUESTS AI_FREE_MODELS \
  AUTOPILOT_ENABLED ALLOW_LIVE_AUTOPILOT AUTOPILOT_MIN_INTERVAL_MIN PLAID_CLIENT_ID PLAID_SECRET PLAID_ENV \
  PLAID_COUNTRY_CODES SALTEDGE_APP_ID SALTEDGE_SECRET MONO_SECRET_KEY MONO_WEBHOOK_SECRET SNAPTRADE_CLIENT_ID \
  SNAPTRADE_CONSUMER_KEY FLUTTERWAVE_SECRET_KEY FLUTTERWAVE_WEBHOOK_HASH \
  MPESA_ENV MPESA_CONSUMER_KEY MPESA_CONSUMER_SECRET MPESA_SHORTCODE MPESA_PASSKEY MPESA_TRANSACTION_TYPE \
  MPESA_PARTY_B MPESA_B2C_SHORTCODE MPESA_INITIATOR_NAME MPESA_SECURITY_CREDENTIAL MTN_MOMO_ENV \
  MTN_MOMO_TARGET_ENVIRONMENT MTN_MOMO_CURRENCY MTN_MOMO_COLLECTION_SUBSCRIPTION_KEY \
  MTN_MOMO_COLLECTION_USER_ID MTN_MOMO_COLLECTION_API_KEY MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY \
  MTN_MOMO_DISBURSEMENT_USER_ID MTN_MOMO_DISBURSEMENT_API_KEY PAYPAL_ENV PAYPAL_CLIENT_ID \
  PAYPAL_CLIENT_SECRET WISE_ENV WISE_API_TOKEN WISE_PROFILE_ID WISE_FUNDING_CURRENCY COINBASE_CLIENT_ID \
  COINBASE_CLIENT_SECRET \
  SKRILL_EMAIL SKRILL_SECRET_WORD SKRILL_API_PASSWORD MONEYGRAM_ENV MONEYGRAM_CLIENT_ID \
  MONEYGRAM_CLIENT_SECRET MONEYGRAM_PARTNER_ID MONEYGRAM_SEND_CURRENCIES MPESA_CALLBACK_IPS ALLOWED_ORIGINS \
  SESSION_IDLE_MINUTES SESSION_TTL_HOURS REAUTH_WINDOW_MINUTES STEP_UP_SEND_USD SECURITY_HOLD_HOURS \
  LOGIN_MAX_ATTEMPTS LOGIN_LOCK_MINUTES PASSWORD_MIN_LENGTH \
  RESEND_API_KEY EMAIL_FROM REQUIRE_EMAIL_VERIFICATION LIVE_UPGRADE_AUTO_APPROVE LIVE_COUNTRIES LIVE_MIN_PRACTICE_TRADES PAPER_STARTING_CASH; do
  if [ -n "${!name:-}" ]; then VARS=$(echo "$VARS" | jq -c --arg k "$name" --arg v "${!name}" '. + {($k): $v}'); fi
done
gql 'mutation($i: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $i) }' \
  "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENV_ID" --arg s "$SERVICE_ID" --argjson v "$VARS" '{i: {projectId: $p, environmentId: $e, serviceId: $s, variables: $v, skipDeploys: true}}')" >/dev/null
echo "set: $(echo "$VARS" | jq -r 'keys | join(", ")')"

step "Uploading and building (Dockerfile)"
railway up --detach --project "$PROJECT_ID" --environment "$ENV_ID" --service "$SERVICE_ID"

step "Waiting for the deployment"
for _ in $(seq 1 90); do
  STATUS=$(gql 'query($i: DeploymentListInput!) { deployments(input: $i, first: 1) { edges { node { status } } } }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENV_ID" --arg s "$SERVICE_ID" '{i: {projectId: $p, environmentId: $e, serviceId: $s}}')" |
    jq -r '.data.deployments.edges[0].node.status // "UNKNOWN"')
  printf '\r  status: %-12s' "$STATUS"
  case "$STATUS" in
    SUCCESS) echo; break ;;
    FAILED | CRASHED | REMOVED) echo; echo "Deployment $STATUS. Open the Railway dashboard for build logs." >&2; exit 1 ;;
  esac
  sleep 10
done

step "Health check"
curl -fsS "https://$DOMAIN/api/health" && echo
printf '\n\033[1;32mAurex is live: https://%s\033[0m\n' "$DOMAIN"
