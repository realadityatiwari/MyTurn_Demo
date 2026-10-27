#!/bin/sh
# Container entrypoint. Starts as root only to (1) make the mounted volume writable for the unprivileged "node" user and
# (2) optionally enter maintenance mode, then drops privileges and execs the app (so Node is PID 1 and receives SIGTERM/SIGINT).
set -e

data_dir="$(dirname "${DATABASE_PATH:-/data/myturn.db}")"

if [ "$(id -u)" = "0" ]; then
  case "$data_dir" in
    # Only ever touch the volume mount (never "/" or system paths). The directory is NOT created: a missing volume must stop the app.
    /data|/data/*) if [ -d "$data_dir" ]; then chown -R node:node "$data_dir" || echo "WARNING: could not change ownership of $data_dir; the app may be unable to write its database" >&2; fi ;;
    *) echo "WARNING: DATABASE_PATH is outside /data; volume ownership was not adjusted" >&2 ;;
  esac
fi

# Maintenance mode (restore procedure): the app and the database are NOT opened, so `fly ssh console` can run
# `node server/backup.js restore ... --yes` safely. Enable with MYTURN_MAINTENANCE=1, disable by unsetting it. See DEPLOYMENT.md.
if [ "${MYTURN_MAINTENANCE:-}" = "1" ]; then
  echo "MAINTENANCE MODE: MyTurn is NOT running. Unset MYTURN_MAINTENANCE to start it." >&2
  exec sleep infinity
fi

if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
