#!/usr/bin/env bash
# Installs (or updates) Aurex on an Ubuntu 22.04/24.04 server: AWS EC2, Lightsail or any VPS.
#
#   sudo ADMIN_EMAIL=you@example.com ./deploy/aws/install.sh
#
# Optional settings (environment variables):
#   DOMAIN         Your domain, e.g. aurex.example.com (its DNS A record must point at this server).
#                  Default: <public-ip>.sslip.io, a free hostname that works with HTTPS straight away.
#   BACKUP_BUCKET  S3 bucket for continuous database backups (needs an IAM role or AWS keys).
#   AWS_REGION     Region of the bucket and of Parameter Store (detected on EC2).
#   PARAM_PREFIX   Parameter Store path to keep MASTER_KEY and ADMIN_SETUP_CODE in, e.g. /aurex/prod.
#   PAYMENT_RAILS  Default "sandbox" (test money). See .env.example for real providers.
#   NODE_IMAGE     Base image for the build (default node:22-slim).
#
# Safe to run again: secrets already in .env (or Parameter Store) are kept, and the app is rebuilt
# from the code in this checkout. To update: git pull, then run this script again.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/.env"
log() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "Run as root: sudo $0" >&2; exit 1; }

# Values from a previous run win over defaults, so re-running never rotates secrets.
existing() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
ADMIN_EMAIL="${ADMIN_EMAIL:-$(existing ADMIN_EMAILS)}"
[ -n "$ADMIN_EMAIL" ] || { echo "Set ADMIN_EMAIL, e.g. sudo ADMIN_EMAIL=you@example.com $0" >&2; exit 1; }

log "Installing Docker, Compose and tools"
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y docker.io docker-compose-v2 openssl curl jq git
fi
systemctl enable --now docker

# Small instances (2 GB) need some swap to build the web app.
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
AWS_REGION="${AWS_REGION:-$(existing AWS_REGION)}"
AWS_REGION="${AWS_REGION:-$(imds placement/region || true)}"

DOMAIN="${DOMAIN:-$(existing DOMAIN)}"
if [ -z "$DOMAIN" ]; then
  IP="$(imds public-ipv4 || curl -fsS -m 5 https://checkip.amazonaws.com || true)"
  IP="$(echo "$IP" | tr -d '[:space:]')"
  [ -n "$IP" ] || { echo "Couldn't detect this server's public IP; set DOMAIN" >&2; exit 1; }
  DOMAIN="${IP//./-}.sslip.io"
fi

# Secrets: Parameter Store (if PARAM_PREFIX is set) so they survive a rebuilt server, else .env.
PARAM_PREFIX="${PARAM_PREFIX:-$(existing PARAM_PREFIX)}"
have_aws() { command -v aws >/dev/null && [ -n "$PARAM_PREFIX" ] && [ -n "$AWS_REGION" ]; }
if [ -n "$PARAM_PREFIX" ] && ! command -v aws >/dev/null; then
  log "Installing the AWS CLI"
  snap install aws-cli --classic >/dev/null 2>&1 || apt-get install -y awscli >/dev/null 2>&1 || true
  hash -r
fi
secret() { # name, generator
  local name="$1" value
  value="$(existing "$name")"
  if [ -z "$value" ] && have_aws; then
    value="$(aws ssm get-parameter --region "$AWS_REGION" --with-decryption --name "$PARAM_PREFIX/$name" --query Parameter.Value --output text 2>/dev/null || true)"
  fi
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    value="$($2)"
    if have_aws; then
      aws ssm put-parameter --region "$AWS_REGION" --type SecureString --name "$PARAM_PREFIX/$name" --value "$value" >/dev/null \
        || echo "warning: couldn't save $name to Parameter Store; it's only in $ENV_FILE" >&2
    fi
  fi
  printf '%s' "$value"
}
MASTER_KEY="$(secret MASTER_KEY 'openssl rand -hex 32')"
ADMIN_SETUP_CODE="$(secret ADMIN_SETUP_CODE 'openssl rand -hex 16')"

BACKUP_BUCKET="${BACKUP_BUCKET:-$(existing BACKUP_BUCKET)}"
PAYMENT_RAILS="${PAYMENT_RAILS:-$(existing PAYMENT_RAILS)}"
PAYMENT_RAILS="${PAYMENT_RAILS:-sandbox}"

log "Writing $ENV_FILE"
# Keep any extra settings you added by hand (provider keys etc.); rewrite only the managed ones.
MANAGED='^(DOMAIN|ACME_EMAIL|APP_URL|ADMIN_EMAILS|ADMIN_SETUP_CODE|MASTER_KEY|PAYMENT_RAILS|BACKUP_BUCKET|AWS_REGION|PARAM_PREFIX|COMPOSE_PROFILES|NODE_IMAGE)='
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
  echo "COMPOSE_PROFILES=$([ -n "$BACKUP_BUCKET" ] && echo backup)"
  echo "NODE_IMAGE=${NODE_IMAGE:-node:22-slim}"
  echo "# Add provider keys below (see .env.example in the repository root), then re-run install.sh."
  [ -n "$EXTRA" ] && echo "$EXTRA"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

if [ -n "$BACKUP_BUCKET" ] && ! docker volume inspect aurex_aurex-data >/dev/null 2>&1; then
  # A brand-new server with a bucket that already holds backups (e.g. after replacing the server):
  # restore the latest copy before the app starts.
  log "Checking $BACKUP_BUCKET for an existing backup to restore"
  docker compose -f "$HERE/docker-compose.yml" --env-file "$ENV_FILE" run --rm --no-deps litestream \
    restore -if-db-not-exists -if-replica-exists /data/aurex.db || echo "No backup restored (that's normal on a first install)."
fi

log "Building and starting Aurex (the first build takes a few minutes)"
PROFILES=()
[ -n "$BACKUP_BUCKET" ] && PROFILES=(--profile backup)
docker compose -f "$HERE/docker-compose.yml" --env-file "$ENV_FILE" "${PROFILES[@]}" up -d --build --remove-orphans

log "Waiting for the app to become healthy"
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose -f "$HERE/docker-compose.yml" --env-file "$ENV_FILE" ps -q app)" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  sleep 5
done
[ "$status" = "healthy" ] || { echo "The app didn't become healthy; see: docker compose -f $HERE/docker-compose.yml logs app" >&2; exit 1; }

cat <<DONE

Aurex is running.
  Address:          https://$DOMAIN   (HTTPS can take a minute the first time)
  Admin email:      $ADMIN_EMAIL
  Admin setup code: stored in $ENV_FILE$( [ -n "$PARAM_PREFIX" ] && echo " and in Parameter Store at $PARAM_PREFIX/ADMIN_SETUP_CODE")
  Backups:          $( [ -n "$BACKUP_BUCKET" ] && echo "streaming to s3://$BACKUP_BUCKET/aurex" || echo "OFF (set BACKUP_BUCKET to turn on)")

Next: sign up with $ADMIN_EMAIL, verify your email, turn on 2FA, then enter the setup code
under Settings -> Admin access.
DONE
