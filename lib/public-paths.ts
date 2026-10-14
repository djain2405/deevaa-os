/** Paths reachable without an app session. `/api/cron` and `/api/intake` authenticate with their own secrets. */
export function isPublicPath(pathname: string) {
  return (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/') ||
    pathname === '/api/cron' ||
    pathname === '/api/intake' ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico'
  );
}
