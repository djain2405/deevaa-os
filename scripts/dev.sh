#!/usr/bin/env sh
# Cursor/vitest sometimes export test OAuth values in the parent shell; those override
# .env.local in Next.js. Clear them so local credentials from .env.local are used.
unset ALLOWED_EMAIL AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET AUTH_SECRET TOKEN_ENCRYPTION_KEY PGLITE_DIR DATABASE_URL 2>/dev/null
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
export PGLITE_DIR="$ROOT/.data/pglite"
cd "$ROOT" || exit 1
exec npx next dev "$@"
