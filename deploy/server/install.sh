#!/usr/bin/env bash
# Installs (or updates) Aurex on an Ubuntu 22.04/24.04 server: AWS EC2, Lightsail or any VPS.
#
#   sudo ADMIN_EMAIL=you@example.com ./deploy/server/install.sh
#
# Optional settings (environment variables):
#   DOMAIN         Your domain, e.g. aurex.example.com (its DNS A record must point at this server).
#                  Default: <public-ip>.sslip.io, a free hostname that works with HTTPS straight away.
#   PAYMENT_RAILS  Default "sandbox" (test money). See .env.example for real providers.
#   NODE_IMAGE     Base image for the build (default node:22-slim).
#
#   BACKUP_BUCKET  S3 bucket for continuous database backups. On EC2 the server's IAM role grants access;
#                  elsewhere, put AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env.litestream.
#   AWS_REGION     Region of the bucket and of Parameter Store (detected on EC2).
#   PARAM_PREFIX   Parameter Store path to keep MASTER_KEY and ADMIN_SETUP_CODE in, e.g. /aurex/prod.
#                  API keys can live there too: create <PARAM_PREFIX>/RESEND_API_KEY (or any key name from
#                  .env.example, such as MPESA_CONSUMER_SECRET) as a SecureString, then re-run this script.
#
# Safe to run again: secrets already in .env (or Parameter Store) are kept, and the app is rebuilt
# from the code in this checkout. To update: git pull, then run this script again.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/.env"
BACKUP_ENV_FILE="$HERE/.env.litestream" # backup credentials, given only to the backup container
COMPOSE=(docker compose -f "$HERE/docker-compose.yml" --env-file "$ENV_FILE")
log() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
warn() { echo "warning: $*" >&2; }

[ "$(id -u)" = "0" ] || { echo "Run as root: sudo $0" >&2; exit 1; }

# Values from a previous run win over defaults, so re-running never rotates secrets.
existing() { [ -f "${2:-$ENV_FILE}" ] && grep -E "^$1=" "${2:-$ENV_FILE}" | tail -1 | cut -d= -f2- || true; }
ADMIN_EMAIL="${ADMIN_EMAIL:-$(existing ADMIN_EMAILS)}"
[ -n "$ADMIN_EMAIL" ] || { echo "Set ADMIN_EMAIL, e.g. sudo ADMIN_EMAIL=you@example.com $0" >&2; exit 1; }

log "Installing Docker, Compose and tools"
export DEBIAN_FRONTEND=noninteractive
APT=(apt-get -o DPkg::Lock::Timeout=600) # wait for unattended-upgrades on a fresh server
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  "${APT[@]}" update -y
  "${APT[@]}" install -y docker.io docker-compose-v2 openssl curl jq git
fi
systemctl enable --now docker

# Small servers (1-2 GB) need some swap to build the web app.
if ! swapon --show | grep -q . && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 4000000 ]; then
  log "Adding 2 GB of swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# EC2 instance metadata (IMDSv2), when available.
imds() {
  local token
  token=$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null) || return 1
  curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null
}

# ---- Settings -----------------------------------------------------------------------------------
setting() { local v="${!1:-}"; [ -n "$v" ] || v="$(existing "$1")"; printf '%s' "${v:-${2:-}}"; }
PARAM_PREFIX="$(setting PARAM_PREFIX)"
BACKUP_BUCKET="$(setting BACKUP_BUCKET)"
PAYMENT_RAILS="$(setting PAYMENT_RAILS sandbox)"
AWS_REGION="$(setting AWS_REGION)"
if [ -z "$AWS_REGION" ] && { [ -n "$BACKUP_BUCKET" ] || [ -n "$PARAM_PREFIX" ]; }; then
  AWS_REGION="$(imds placement/region || true)"
fi

DOMAIN="$(setting DOMAIN)"
if [ -z "$DOMAIN" ]; then
  IP="$(imds public-ipv4 || curl -fsS -m 5 https://checkip.amazonaws.com || true)"
  IP="$(echo "$IP" | tr -d '[:space:]')"
  [ -n "$IP" ] || { echo "Couldn't detect this server's public IP; set DOMAIN" >&2; exit 1; }
  DOMAIN="${IP//./-}.sslip.io"
fi

# ---- Secrets: kept in Parameter Store (if PARAM_PREFIX is set) so they survive a rebuilt server ------
# If Parameter Store is configured but can't be read, stop: inventing a new MASTER_KEY on a rebuilt
# server would make the restored database's encrypted data unreadable.
if [ -n "$PARAM_PREFIX" ] && ! command -v aws >/dev/null; then
  log "Installing the AWS CLI"
  snap install aws-cli --classic >/dev/null 2>&1 || "${APT[@]}" install -y awscli >/dev/null 2>&1 || true
  hash -r
fi

store_get() { # NAME -> stored value, or nothing if the store doesn't have it
  local out
  if [ -n "$PARAM_PREFIX" ]; then
    { command -v aws >/dev/null && [ -n "$AWS_REGION" ]; } \
      || { echo "error: PARAM_PREFIX is set but the AWS CLI or AWS_REGION is missing" >&2; return 1; }
    if out="$(aws ssm get-parameter --region "$AWS_REGION" --with-decryption --name "$PARAM_PREFIX/$1" \
      --query Parameter.Value --output text 2>&1)"; then
      printf '%s' "$out"
      return 0
    fi
    case "$out" in
      *ParameterNotFound*) ;;
      *) echo "error: couldn't read $PARAM_PREFIX/$1 from Parameter Store: $out" >&2; return 1 ;;
    esac
  fi
  return 0
}
store_put() { # NAME value
  if [ -n "$PARAM_PREFIX" ]; then
    aws ssm put-parameter --region "$AWS_REGION" --type SecureString --name "$PARAM_PREFIX/$1" --value "$2" >/dev/null \
      || warn "couldn't save $1 to Parameter Store; it's only in $ENV_FILE"
  fi
  return 0
}
secret() { # NAME generator
  local value
  value="$(existing "$1")"
  if [ -z "$value" ]; then value="$(store_get "$1")" || exit 1; fi
  if [ -z "$value" ]; then
    value="$($2)"
    store_put "$1" "$value"
  fi
  printf '%s' "$value"
}
MASTER_KEY="$(secret MASTER_KEY 'openssl rand -hex 32')" || { echo "Fix the Parameter Store access above, then run $0 again." >&2; exit 1; }
ADMIN_SETUP_CODE="$(secret ADMIN_SETUP_CODE 'openssl rand -hex 16')" || { echo "Fix the Parameter Store access above, then run $0 again." >&2; exit 1; }

# API keys added in Parameter Store (any secret name from .env.example, e.g. RESEND_API_KEY). Adding them
# there means no pasting into a terminal; they override the same names in .env. A key deleted there is
# removed from .env on the next run (only when AWS confirms it's gone, never because of an error).
declare -A STORED=() GONE=()
EXAMPLE="$HERE/../../.env.example"
STORE_MARK='# From Parameter Store (change or delete them there, then re-run install.sh):'
# Names this script took from Parameter Store last time (listed on the marker line in .env).
read -r -a PREV_STORED <<< "$( [ -f "$ENV_FILE" ] && grep -m1 '^# From Parameter Store' "$ENV_FILE" \
  | sed 's/^[^:]*: *//' | tr ' ' '\n' | grep -E '^[A-Z0-9_]+$' | tr '\n' ' ' || true)"
if [ -n "$PARAM_PREFIX" ] && [ -n "$AWS_REGION" ] && command -v aws >/dev/null && [ -f "$EXAMPLE" ]; then
  log "Reading API keys from Parameter Store ($PARAM_PREFIX/...)"
  # Each lookup prints "NAME<tab>value", or "NAME<tab>" when the parameter doesn't exist; errors print nothing.
  while IFS=$'\t' read -r name value; do
    [ -n "$name" ] || continue
    if [ -n "$value" ]; then STORED[$name]="$value"; else GONE[$name]=1; fi
  done < <(grep -oE '^[A-Z0-9_]+=' "$EXAMPLE" | tr -d '=' | grep -E 'KEY|SECRET|TOKEN|PASSWORD|PASSKEY|WORD' \
    | grep -Ev '^MASTER_KEY' | sort -u \
    | xargs -P 8 -I{} sh -c 'if out=$(aws ssm get-parameter --region "$0" --with-decryption --name "$1/{}" \
          --query Parameter.Value --output text 2>&1); then printf "%s\t%s\n" "{}" "$out";
        else case "$out" in *ParameterNotFound*) printf "%s\t\n" "{}" ;; esac; fi' "$AWS_REGION" "$PARAM_PREFIX")
  [ "${#STORED[@]}" -gt 0 ] && echo "Found: ${!STORED[*]}"
fi
# Lines to replace or remove in .env: keys found now, and previous keys confirmed deleted.
DROP=("${!STORED[@]}")
KEEP_LISTED=() # previous keys that couldn't be checked this time: kept, and still listed
for name in "${PREV_STORED[@]}"; do
  if [ -n "${GONE[$name]:-}" ]; then
    DROP+=("$name")
    echo "Removed $name (deleted from Parameter Store)"
  elif [ -z "${STORED[$name]:-}" ]; then
    KEEP_LISTED+=("$name")
  fi
done

log "Writing $ENV_FILE"
# Keep any extra settings you added by hand (provider keys etc.); rewrite only the managed ones.
MANAGED='^(DOMAIN|ACME_EMAIL|APP_URL|ADMIN_EMAILS|ADMIN_SETUP_CODE|MASTER_KEY|PAYMENT_RAILS|BACKUP_BUCKET|AWS_REGION|PARAM_PREFIX|COMPOSE_PROFILES|NODE_IMAGE)='
DROP_RE="^($(IFS='|'; echo "${DROP[*]}"))="
EXTRA="$( [ -f "$ENV_FILE" ] && grep -Ev "$MANAGED" "$ENV_FILE" | grep -Ev '^# (Managed|Add|From Parameter Store)' \
  | { if [ "${#DROP[@]}" -gt 0 ]; then grep -Ev "$DROP_RE"; else cat; fi; } || true)"
umask 077
{
  echo "# Managed by install.sh. Re-run it after changing DOMAIN; secrets are kept."
  echo "DOMAIN=$DOMAIN"
  echo "ACME_EMAIL=$ADMIN_EMAIL"
  echo "APP_URL=https://$DOMAIN"
  echo "ADMIN_EMAILS=$ADMIN_EMAIL"
  echo "ADMIN_SETUP_CODE=$ADMIN_SETUP_CODE"
  echo "MASTER_KEY=$MASTER_KEY"
  echo "PAYMENT_RAILS=$PAYMENT_RAILS"
  echo "BACKUP_BUCKET=$BACKUP_BUCKET"
  echo "AWS_REGION=$AWS_REGION"
  echo "PARAM_PREFIX=$PARAM_PREFIX"
  echo "COMPOSE_PROFILES=$([ -n "$BACKUP_BUCKET" ] && echo backup)"
  echo "NODE_IMAGE=${NODE_IMAGE:-node:22-slim}"
  echo "# Add provider keys below (see .env.example in the repository root), then re-run install.sh."
  [ -n "$EXTRA" ] && echo "$EXTRA"
  if [ "${#STORED[@]}" -gt 0 ] || [ "${#KEEP_LISTED[@]}" -gt 0 ]; then
    echo "$STORE_MARK ${!STORED[*]} ${KEEP_LISTED[*]}"
    for name in "${!STORED[@]}"; do echo "$name=${STORED[$name]}"; done
  fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
if [ ! -f "$BACKUP_ENV_FILE" ]; then
  {
    echo "# Credentials for the backup container only; the app never sees them. Not needed on EC2 with an"
    echo "# IAM role. On other servers, add AWS_ACCESS_KEY_ID=... and AWS_SECRET_ACCESS_KEY=... lines here."
  } > "$BACKUP_ENV_FILE"
fi
chmod 600 "$BACKUP_ENV_FILE"

if [ -n "$BACKUP_BUCKET" ] && ! docker volume inspect aurex_aurex-data >/dev/null 2>&1; then
  # A brand-new server with a bucket that already holds backups (e.g. after replacing the server):
  # restore the latest copy before the app starts.
  log "Checking $BACKUP_BUCKET for an existing backup to restore"
  "${COMPOSE[@]}" run --rm --no-deps litestream restore -if-db-not-exists -if-replica-exists /data/aurex.db \
    || echo "No backup restored (that's normal on a first install)."
fi

# ---- Monitoring on AWS (when the CloudFormation stack provides it) ------------------------------
# The stack name is the last part of PARAM_PREFIX (/aurex/<stack>). Its alarms watch the app log
# (errors, a broken ledger seal) and a disk-use metric this server reports every 10 minutes.
MONITORING=""
if [ -n "$PARAM_PREFIX" ] && [ -n "$AWS_REGION" ] && command -v aws >/dev/null; then
  STACK="${PARAM_PREFIX##*/}"
  AWSLOGS_GROUP="$PARAM_PREFIX/app"
  if [ "$(aws logs describe-log-groups --region "$AWS_REGION" --log-group-name-prefix "$AWSLOGS_GROUP" \
        --query "logGroups[?logGroupName=='$AWSLOGS_GROUP'] | length(@)" --output text 2>/dev/null || true)" = "1" ]; then
    log "Sending the app's log to CloudWatch Logs ($AWSLOGS_GROUP)"
    export AWSLOGS_GROUP AWS_REGION
    COMPOSE+=(-f "$HERE/docker-compose.awslogs.yml")
    MONITORING="logs"
  fi
  AWS_BIN="$(command -v aws)"
  cat > /usr/local/bin/aurex-disk-metric <<METRIC
#!/bin/sh
# Reports how full the disk is to CloudWatch (namespace Aurex/$STACK), for the stack's disk alarm.
used=\$(df --output=pcent / | tail -1 | tr -dc '0-9')
"$AWS_BIN" cloudwatch put-metric-data --region "$AWS_REGION" --namespace "Aurex/$STACK" \\
  --metric-name DiskUsedPercent --unit Percent --value "\$used" >/dev/null 2>&1 || true
METRIC
  chmod 755 /usr/local/bin/aurex-disk-metric
  echo "*/10 * * * * root /usr/local/bin/aurex-disk-metric" > /etc/cron.d/aurex-disk-metric
  /usr/local/bin/aurex-disk-metric
  MONITORING="${MONITORING:+$MONITORING, }disk"
fi

log "Building and starting Aurex (the first build takes a few minutes)"
PROFILES=()
[ -n "$BACKUP_BUCKET" ] && PROFILES=(--profile backup)
"${COMPOSE[@]}" "${PROFILES[@]}" up -d --build --remove-orphans

log "Waiting for the app to become healthy"
status=""
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q app)" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  sleep 5
done
[ "$status" = "healthy" ] || { echo "The app didn't become healthy; see: ${COMPOSE[*]} logs app" >&2; exit 1; }

cat <<DONE

Aurex is running.
  Address:          https://$DOMAIN   (HTTPS can take a minute the first time)
  Admin email:      $ADMIN_EMAIL
  Admin setup code: stored in $ENV_FILE$( [ -n "$PARAM_PREFIX" ] && echo " and in Parameter Store at $PARAM_PREFIX/ADMIN_SETUP_CODE")
  Backups:          $( [ -n "$BACKUP_BUCKET" ] && echo "streaming to s3://$BACKUP_BUCKET/aurex" || echo "OFF (set BACKUP_BUCKET to turn on)")
  Monitoring:       $( [ -n "$MONITORING" ] && echo "reporting $MONITORING to CloudWatch" || echo "not set up (needs the AWS stack)")

Next: sign up with $ADMIN_EMAIL, verify your email, turn on 2FA, then enter the setup code
under Settings -> Admin access.
DONE
