#!/bin/bash
# First-boot script for the Aurex VM. main.bicep fills in the placeholders in double braces and passes this file as the
# VM's customData. It clones Aurex and runs the shared installer. Progress: /var/log/aurex-install.log
set -euo pipefail
exec > >(tee -a /var/log/aurex-install.log) 2>&1
echo "Aurex setup started $(date -u)"

export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=600 update -y
apt-get -o DPkg::Lock::Timeout=600 install -y git

mkdir -p /opt/aurex
for attempt in 1 2 3 4 5; do
  [ -d /opt/aurex/src/.git ] && break
  rm -rf /opt/aurex/src
  git clone --depth 1 --branch '{{BRANCH}}' '{{REPOSITORY_URL}}' /opt/aurex/src || sleep $((attempt * 15))
done
[ -d /opt/aurex/src/.git ] || { echo "Couldn't clone {{REPOSITORY_URL}}"; exit 1; }

cd /opt/aurex/src
ADMIN_EMAIL='{{ADMIN_EMAIL}}' \
DOMAIN='{{DOMAIN}}' \
PAYMENT_RAILS='{{PAYMENT_RAILS}}' \
KEY_VAULT='{{KEY_VAULT}}' \
AZURE_STORAGE_ACCOUNT='{{STORAGE_ACCOUNT}}' \
AZURE_STORAGE_CONTAINER='{{STORAGE_CONTAINER}}' \
  ./deploy/server/install.sh

echo "Aurex setup finished $(date -u)"
