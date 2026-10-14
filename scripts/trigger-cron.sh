#!/bin/sh
# Calls the app's scheduler endpoint. Used by Railway cron (see railway.toml).
set -eu
if [ -z "${APP_URL:-}" ] || [ -z "${CRON_SECRET:-}" ]; then
  echo "trigger-cron: APP_URL and CRON_SECRET must be set" >&2
  exit 1
fi
BASE="${APP_URL%/}"
curl -sfS -H "Authorization: Bearer ${CRON_SECRET}" "${BASE}/api/cron"
