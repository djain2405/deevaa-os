/** Canonical https origin for Auth.js callbacks (Railway internal PORT must not be used). */

function parseOrigin(raw: string | undefined) {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const href = value.startsWith('http') ? value : `https://${value}`;
    return new URL(href).origin;
  } catch {
    return undefined;
  }
}

export function isLoopbackOrigin(origin: string) {
  try {
    const {hostname} = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0';
  } catch {
    return false;
  }
}

export function authOrigin(env: NodeJS.Dict<string> = process.env) {
  const candidates = [
    parseOrigin(env.AUTH_URL),
    parseOrigin(env.NEXTAUTH_URL),
    parseOrigin(env.APP_URL),
    parseOrigin(env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined)
  ].filter((value): value is string => Boolean(value));
  return candidates.find((origin) => !isLoopbackOrigin(origin)) ?? candidates[0];
}

/** Origin for app redirects after OAuth. Never send the browser to Railway's internal localhost:8080. */
export function appOrigin(req?: Request, env: NodeJS.Dict<string> = process.env) {
  const configured = authOrigin(env);
  const fromReq = req ? new URL(req.url).origin : undefined;
  if (configured && !isLoopbackOrigin(configured)) return configured;
  if (fromReq && !isLoopbackOrigin(fromReq)) return fromReq;
  return configured ?? fromReq ?? 'http://localhost:3000';
}
