#!/usr/bin/env bash
# Installs (or updates) Aurex on an Ubuntu 22.04/24.04 server: AWS EC2, Azure, Lightsail or any VPS.
#
#   sudo ADMIN_EMAIL=you@example.com ./deploy/server/install.sh
#
# Optional settings (environment variables):
#   DOMAIN         Your domain, e.g. aurex.example.com (its DNS A record must point at this server).
#                  Default: <public-ip>.sslip.io, a free hostname that works with HTTPS straight away.
#   PAYMENT_RAILS  Default "sandbox" (test money). See .env.example for real providers.
#   NODE_IMAGE     Base image for the build (default node:22-slim).
#
#   AWS: continuous backups to S3 and secrets in Parameter Store (uses the server's IAM role)
#   BACKUP_BUCKET  S3 bucket for database backups.
#   AWS_REGION     Region of the bucket and of Parameter Store (detected on EC2).
#   PARAM_PREFIX   Parameter Store path for MASTER_KEY and ADMIN_SETUP_CODE, e.g. /aurex/prod.
#
#   Azure: continuous backups to Blob Storage and secrets in Key Vault (uses the VM's managed identity)
#   AZURE_STORAGE_ACCOUNT    Storage account for database backups.
#   AZURE_STORAGE_CONTAINER  Blob container (default "backups").
#   AZURE_STORAGE_KEY        The account's access key. Default: read from the Key Vault secret STORAGE-KEY.
#   KEY_VAULT                Key Vault name for MASTER-KEY and ADMIN-SETUP-CODE (and STORAGE-KEY).
#
# Safe to run again: secrets already in .env (or in Parameter Store / Key Vault) are kept, and the app is
# rebuilt from the code in this checkout. To update: git pull, then run this script again.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/.env"
BACKUP_ENV_FILE="$HERE/.env.litestream" # backup credentials, given only to the Litestream container
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
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1 || ! command -v jq >/dev/null; then
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
KEY_VAULT="$(setting KEY_VAULT)"
AZURE_STORAGE_ACCOUNT="$(setting AZURE_STORAGE_ACCOUNT)"
AZURE_STORAGE_CONTAINER="$(setting AZURE_STORAGE_CONTAINER backups)"
AZURE_BLOB_ENDPOINT="$(setting AZURE_BLOB_ENDPOINT)" # only for sovereign clouds or the Azurite emulator
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

# ---- Secret stores: AWS Parameter Store or Azure Key Vault, so secrets survive a rebuilt server ----
# If a store is configured but can't be read, stop: inventing a new MASTER_KEY on a rebuilt server would
# make the restored database's encrypted data unreadable.
if [ -n "$PARAM_PREFIX" ] && ! command -v aws >/dev/null; then
  log "Installing the AWS CLI"
  snap install aws-cli --classic >/dev/null 2>&1 || "${APT[@]}" install -y awscli >/dev/null 2>&1 || true
  hash -r
fi

KV_BODY="$(mktemp)"
trap 'rm -f "$KV_BODY"' EXIT
# One Key Vault call with the VM's managed identity. Prints the HTTP status; the response body is in $KV_BODY.
kv() { # GET|PUT secret-name [value]
  local token status args
  : > "$KV_BODY"
  token="$(curl -fsS -m 5 -H Metadata:true \
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net' \
    2>/dev/null | jq -r '.access_token // empty' 2>/dev/null || true)"
  [ -n "$token" ] || { echo 000; return 0; }
  args=(-sS -m 15 -o "$KV_BODY" -w '%{http_code}' -X "$1" -H "Authorization: Bearer $token")
  if [ "$1" = PUT ]; then args+=(-H 'Content-Type: application/json' --data "$(jq -cn --arg v "$3" '{value: $v}')"); fi
  status="$(curl "${args[@]}" "https://$KEY_VAULT.vault.azure.net/secrets/$2?api-version=7.4" 2>/dev/null || true)"
  echo "${status:-000}"
}
# Prints a secret's value (nothing if it doesn't exist). Waits up to 10 minutes for access: the template
# grants it right after creating the VM and new role assignments take a few minutes to apply.
kv_read() { # secret-name
  local status i
  for i in $(seq 1 60); do
    status="$(kv GET "$1")"
    case "$status" in
      200) jq -r '.value // empty' "$KV_BODY"; return 0 ;;
      404) return 0 ;;
    esac
    [ "$i" = 1 ] && echo "Waiting for access to Key Vault $KEY_VAULT (HTTP $status; new access can take a few minutes)..." >&2
    sleep 10
  done
  echo "Key Vault $KEY_VAULT answered HTTP $status for $1" >&2
  return 1
}
kv_write() { # secret-name value
  local status i
  for i in 1 2 3 4 5 6; do
    status="$(kv PUT "$1" "$2")"
    [ "$status" = 200 ] && return 0
    sleep 10
  done
  warn "couldn't save $1 to Key Vault $KEY_VAULT (HTTP $status); it's only in $ENV_FILE"
}

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
  if [ -n "$KEY_VAULT" ]; then
    kv_read "${1//_/-}" || { echo "error: couldn't read ${1//_/-} from Key Vault $KEY_VAULT" >&2; return 1; }
  fi
  return 0
}
store_put() { # NAME value
  if [ -n "$PARAM_PREFIX" ]; then
    aws ssm put-parameter --region "$AWS_REGION" --type SecureString --name "$PARAM_PREFIX/$1" --value "$2" >/dev/null \
      || warn "couldn't save $1 to Parameter Store; it's only in $ENV_FILE"
  fi
  if [ -n "$KEY_VAULT" ]; then kv_write "${1//_/-}" "$2"; fi
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
MASTER_KEY="$(secret MASTER_KEY 'openssl rand -hex 32')" || { echo "Fix the secret store access above, then run $0 again." >&2; exit 1; }
ADMIN_SETUP_CODE="$(secret ADMIN_SETUP_CODE 'openssl rand -hex 16')" || { echo "Fix the secret store access above, then run $0 again." >&2; exit 1; }

# ---- Backups ------------------------------------------------------------------------------------
BACKUP_TARGET=""
if [ -n "$BACKUP_BUCKET" ]; then
  BACKUP_TARGET=s3
  BACKUP_WHERE="s3://$BACKUP_BUCKET/aurex"
elif [ -n "$AZURE_STORAGE_ACCOUNT" ]; then
  BACKUP_TARGET=azure
  BACKUP_WHERE="${AZURE_BLOB_ENDPOINT:-https://$AZURE_STORAGE_ACCOUNT.blob.core.windows.net}/$AZURE_STORAGE_CONTAINER/aurex"
  # The access key is re-read on every run, so rotating it is: update the secret, re-run this script.
  AZURE_STORAGE_KEY="${AZURE_STORAGE_KEY:-}"
  if [ -z "$AZURE_STORAGE_KEY" ] && [ -n "$KEY_VAULT" ]; then AZURE_STORAGE_KEY="$(kv_read STORAGE-KEY || true)"; fi
  if [ -z "$AZURE_STORAGE_KEY" ]; then AZURE_STORAGE_KEY="$(existing LITESTREAM_AZURE_ACCOUNT_KEY "$BACKUP_ENV_FILE")"; fi
  if [ -z "$AZURE_STORAGE_KEY" ]; then
    warn "no access key for storage account $AZURE_STORAGE_ACCOUNT (set AZURE_STORAGE_KEY or KEY_VAULT); backups are OFF"
    BACKUP_TARGET=""
  fi
fi

log "Writing $ENV_FILE"
# Keep any extra settings you added by hand (provider keys etc.); rewrite only the managed ones.
MANAGED='^(DOMAIN|ACME_EMAIL|APP_URL|ADMIN_EMAILS|ADMIN_SETUP_CODE|MASTER_KEY|PAYMENT_RAILS|BACKUP_BUCKET|AWS_REGION|PARAM_PREFIX|KEY_VAULT|AZURE_STORAGE_ACCOUNT|AZURE_STORAGE_CONTAINER|AZURE_BLOB_ENDPOINT|BACKUP_TARGET|COMPOSE_PROFILES|NODE_IMAGE)='
EXTRA="$( [ -f "$ENV_FILE" ] && grep -Ev "$MANAGED" "$ENV_FILE" | grep -Ev '^# (Managed|Add)' || true)"
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
  echo "KEY_VAULT=$KEY_VAULT"
  echo "AZURE_STORAGE_ACCOUNT=$AZURE_STORAGE_ACCOUNT"
  echo "AZURE_STORAGE_CONTAINER=$AZURE_STORAGE_CONTAINER"
  echo "AZURE_BLOB_ENDPOINT=$AZURE_BLOB_ENDPOINT"
  echo "BACKUP_TARGET=${BACKUP_TARGET:-s3}"
  echo "COMPOSE_PROFILES=$([ -n "$BACKUP_TARGET" ] && echo backup)"
  echo "NODE_IMAGE=${NODE_IMAGE:-node:22-slim}"
  echo "# Add provider keys below (see .env.example in the repository root), then re-run install.sh."
  [ -n "$EXTRA" ] && echo "$EXTRA"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
{
  echo "# Managed by install.sh: credentials only the backup container sees."
  [ "$BACKUP_TARGET" = azure ] && echo "LITESTREAM_AZURE_ACCOUNT_KEY=$AZURE_STORAGE_KEY"
  true
} > "$BACKUP_ENV_FILE"
chmod 600 "$BACKUP_ENV_FILE"

if [ -n "$BACKUP_TARGET" ] && ! docker volume inspect aurex_aurex-data >/dev/null 2>&1; then
  # A brand-new server whose storage already holds backups (e.g. after replacing the server):
  # restore the latest copy before the app starts.
  log "Checking $BACKUP_WHERE for an existing backup to restore"
  "${COMPOSE[@]}" run --rm --no-deps litestream restore -if-db-not-exists -if-replica-exists /data/aurex.db \
    || echo "No backup restored (that's normal on a first install)."
fi

log "Building and starting Aurex (the first build takes a few minutes)"
PROFILES=()
[ -n "$BACKUP_TARGET" ] && PROFILES=(--profile backup)
"${COMPOSE[@]}" "${PROFILES[@]}" up -d --build --remove-orphans

log "Waiting for the app to become healthy"
status=""
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q app)" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  sleep 5
done
[ "$status" = "healthy" ] || { echo "The app didn't become healthy; see: ${COMPOSE[*]} logs app" >&2; exit 1; }

where_code="$ENV_FILE"
[ -n "$PARAM_PREFIX" ] && where_code+=" and in Parameter Store at $PARAM_PREFIX/ADMIN_SETUP_CODE"
[ -n "$KEY_VAULT" ] && where_code+=" and in Key Vault $KEY_VAULT (secret ADMIN-SETUP-CODE)"
cat <<DONE

Aurex is running.
  Address:          https://$DOMAIN   (HTTPS can take a minute the first time)
  Admin email:      $ADMIN_EMAIL
  Admin setup code: stored in $where_code
  Backups:          $( [ -n "$BACKUP_TARGET" ] && echo "streaming to $BACKUP_WHERE" || echo "OFF (set BACKUP_BUCKET or AZURE_STORAGE_ACCOUNT to turn on)")

Next: sign up with $ADMIN_EMAIL, verify your email, turn on 2FA, then enter the setup code
under Settings -> Admin access.
DONE
