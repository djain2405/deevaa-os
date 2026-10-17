/** Canonical https origin for Auth.js callbacks (Railway internal PORT must not be used). */
export function authOrigin() {
  const candidates = [process.env.AUTH_URL, process.env.APP_URL, process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      const href = value.startsWith('http') ? value : `https://${value}`;
      return new URL(href).origin;
    } catch {
      continue;
    }
  }
  return undefined;
}
