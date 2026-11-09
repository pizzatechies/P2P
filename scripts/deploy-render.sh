#!/usr/bin/env bash
# Deploys Aurex to Render from the public GitHub repository, and is safe to re-run:
#   web service (Docker, Starter plan) + 1 GB persistent disk at /data + production variables
#   -> waits for the build -> health check.
#
# Requirements: curl, jq, openssl. A Render API key (Dashboard -> Account settings -> API keys)
# and a payment method on the Render account (persistent disks need a paid instance type).
# Usage:
#   RENDER_API_KEY=<key> ADMIN_EMAILS=you@example.com ./scripts/deploy-render.sh
# Optional: SERVICE_NAME (aurex), REGION (frankfurt), PLAN (starter), BRANCH (current branch),
# REPO_URL, OWNER_ID, plus any app variable from .env.example (e.g. ANTHROPIC_API_KEY) to set it.
set -euo pipefail

: "${RENDER_API_KEY:?Set RENDER_API_KEY to a Render API key}"
NAME="${SERVICE_NAME:-aurex}"
REGION="${REGION:-frankfurt}"
PLAN="${PLAN:-starter}"
REPO_URL="${REPO_URL:-https://github.com/pizzatechies/P2P}"
cd "$(dirname "$0")/.."
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
API="https://api.render.com/v1"

step() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

# render METHOD PATH [JSON] -> prints the body; exits with Render's message on HTTP errors.
render() {
  local method="$1" path="$2" body="${3:-}" out code
  if [ -n "$body" ]; then
    out=$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $RENDER_API_KEY" -H "Accept: application/json" \
      -H "Content-Type: application/json" --data-binary "$body" -w $'\n%{http_code}')
  else
    out=$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $RENDER_API_KEY" -H "Accept: application/json" -w $'\n%{http_code}')
  fi
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [ "$code" -ge 400 ]; then
    echo "Render API $method $path failed ($code): $(echo "$out" | jq -r '.message // .' 2>/dev/null || echo "$out")" >&2
    return 1
  fi
  echo "$out"
}

step "Account"
OWNER_ID="${OWNER_ID:-$(render GET "/owners?limit=20" | jq -r '.[0].owner.id')}"
echo "workspace $OWNER_ID"

step "Service '$NAME'"
SERVICE=$(render GET "/services?name=$NAME&ownerId=$OWNER_ID&limit=20" | jq -c --arg n "$NAME" '[.[].service | select(.name == $n)][0] // empty')
if [ -z "$SERVICE" ]; then
  ENV_VARS=$(jq -nc \
    --arg admins "${ADMIN_EMAILS:-}" \
    --arg key "$(openssl rand -hex 32)" \
    --arg app "https://$NAME.onrender.com" \
    '[{key: "NODE_ENV", value: "production"}, {key: "DATABASE_PATH", value: "/data/aurex.db"},
      {key: "TRUST_PROXY", value: "true"}, {key: "PAYMENT_RAILS", value: "sandbox"},
      {key: "MASTER_KEY", value: $key}, {key: "APP_URL", value: $app}, {key: "ADMIN_EMAILS", value: $admins}]')
  for name in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET P2P_FEE_BPS FX_SPREAD_BPS WITHDRAWAL_FEE_BPS MAX_TX_USD \
    DAILY_LIMIT_USD FX_LIVE ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY MISTRAL_API_KEY GROQ_API_KEY XAI_API_KEY \
    DEEPSEEK_API_KEY OPENROUTER_API_KEY TOGETHER_API_KEY PERPLEXITY_API_KEY AI_DEFAULT_MODEL AI_FREE_DAILY_REQUESTS \
    AI_FREE_MODELS ALPACA_DATA_KEY_ID ALPACA_DATA_SECRET_KEY ALLOW_LIVE_TRADING AI_MAX_POSITION_PCT AUTOPILOT_ENABLED \
    ALLOW_LIVE_AUTOPILOT AUTOPILOT_MIN_INTERVAL_MIN; do
    if [ -n "${!name:-}" ]; then ENV_VARS=$(echo "$ENV_VARS" | jq -c --arg k "$name" --arg v "${!name}" '. + [{key: $k, value: $v}]'); fi
  done
  BODY=$(jq -nc --arg n "$NAME" --arg o "$OWNER_ID" --arg repo "$REPO_URL" --arg branch "$BRANCH" \
    --arg region "$REGION" --arg plan "$PLAN" --argjson env "$ENV_VARS" \
    '{type: "web_service", name: $n, ownerId: $o, repo: $repo, branch: $branch, autoDeploy: "yes", envVars: $env,
      serviceDetails: {runtime: "docker", plan: $plan, region: $region, healthCheckPath: "/api/health", numInstances: 1,
        disk: {name: "aurex-data", mountPath: "/data", sizeGB: 1},
        envSpecificDetails: {dockerfilePath: "./Dockerfile", dockerContext: "."}}}')
  CREATED=$(render POST "/services" "$BODY")
  SERVICE=$(echo "$CREATED" | jq -c '.service')
  echo "created $(echo "$SERVICE" | jq -r '.id')"
  NEW=1
else
  echo "found $(echo "$SERVICE" | jq -r '.id')"
  NEW=0
fi
SERVICE_ID=$(echo "$SERVICE" | jq -r '.id')
URL=$(echo "$SERVICE" | jq -r '.serviceDetails.url')
echo "$URL"

# Render may add a suffix to the hostname if the name is taken: keep APP_URL in step with it.
CURRENT_APP_URL=$(render GET "/services/$SERVICE_ID/env-vars?limit=100" | jq -r '[.[].envVar | select(.key == "APP_URL")][0].value // empty')
NEEDS_DEPLOY=$([ "$NEW" = "1" ] && echo 0 || echo 1)
if [ "$CURRENT_APP_URL" != "$URL" ]; then
  step "Pointing APP_URL at $URL"
  render PUT "/services/$SERVICE_ID/env-vars/APP_URL" "$(jq -nc --arg v "$URL" '{value: $v}')" >/dev/null
  NEEDS_DEPLOY=1
fi
if [ "$NEEDS_DEPLOY" = "1" ]; then
  step "Starting a deploy of $BRANCH"
  sleep 5
  render POST "/services/$SERVICE_ID/deploys" '{"clearCache": "do_not_clear"}' | jq -r '"deploy " + .id'
fi

step "Waiting for the deploy (Docker build takes a few minutes)"
for _ in $(seq 1 120); do
  STATUS=$(render GET "/services/$SERVICE_ID/deploys?limit=1" | jq -r '.[0].deploy.status // "unknown"')
  printf '\r  status: %-22s' "$STATUS"
  case "$STATUS" in
    live) echo; break ;;
    build_failed | update_failed | canceled | pre_deploy_failed | deactivated)
      echo; echo "Deploy $STATUS. Open the service's Logs in the Render dashboard." >&2; exit 1 ;;
  esac
  sleep 15
done

step "Health check"
curl -fsS "$URL/api/health" && echo
printf '\n\033[1;32mAurex is live: %s\033[0m\n' "$URL"
