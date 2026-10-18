/** Paths reachable without an app session. `/api/cron`, `/api/jobs`, and `/api/intake` authenticate with their own secrets. */
export function isPublicPath(pathname: string) {
  return (
    pathname === '/login' ||
    pathname === '/api/health' ||
    pathname.startsWith('/api/auth/') ||
    pathname === '/api/cron' ||
    pathname === '/api/jobs' ||
    pathname === '/api/intake' ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico'
  );
}
