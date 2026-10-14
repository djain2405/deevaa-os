import {createHash, timingSafeEqual} from 'node:crypto';

export const PRIVATE_HEADERS = {'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie'} as const;

export function privateJson(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, {status, headers: {...PRIVATE_HEADERS, ...extra}});
}

export function apiError(status: number, code: string, message: string) {
  return privateJson({error: {code, message}}, status);
}

export const unauthorized = () => apiError(401, 'unauthorized', 'Sign in to continue.');
export const forbiddenOrigin = () => apiError(403, 'bad_origin', 'Request origin was not accepted.');

export function safeEqual(a: string, b: string) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function allowedOrigins(req: Request) {
  const origins = new Set<string>([new URL(req.url).origin]);
  if (process.env.APP_URL) origins.add(new URL(process.env.APP_URL).origin);
  return origins;
}

/** Rejects cross-site state-changing requests. Browsers always send at least one of these headers on POST. */
export function isSameOrigin(req: Request) {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = req.headers.get('origin');
  if (origin) return allowedOrigins(req).has(origin);
  return site === 'same-origin';
}

export function bearerMatches(req: Request, secret: string | undefined) {
  if (!secret || secret.length < 16) return false;
  const header = req.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  return safeEqual(header.slice(7), secret);
}
