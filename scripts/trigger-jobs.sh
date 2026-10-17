#!/bin/sh
# Calls the agent dispatcher. Used by Railway cron (see railway.toml).
set -eu
if [ -z "${APP_URL:-}" ] || [ -z "${CRON_SECRET:-}" ]; then
  echo "trigger-jobs: APP_URL and CRON_SECRET must be set" >&2
  exit 1
fi
BASE="${APP_URL%/}"
curl -sfS -H "Authorization: Bearer ${CRON_SECRET}" "${BASE}/api/jobs"
