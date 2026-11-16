#!/usr/bin/env bash
# The installer moved to deploy/server/install.sh (it also works on Lightsail or any Ubuntu server).
# This wrapper keeps older CloudFormation templates and instructions working.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Carry over settings from an install made before the move.
if [ -f "$HERE/.env" ] && [ ! -f "$HERE/../server/.env" ]; then
  mv "$HERE/.env" "$HERE/../server/.env"
fi
exec "$HERE/../server/install.sh" "$@"
