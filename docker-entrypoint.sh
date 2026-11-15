#!/bin/sh
# Hosting platforms (Render, Railway, ...) mount the data disk owned by root. Start as root just long
# enough to make the data directory writable, then run the app as the unprivileged "node" user.
set -e
# New files (the database, its WAL) are readable only by the app's user.
umask 077
DATA_DIR="$(dirname "${DATABASE_PATH:-/data/aurex.db}")"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
