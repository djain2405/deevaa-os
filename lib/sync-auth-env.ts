import {authOrigin, isLoopbackOrigin} from './auth-url';

/**
 * Auth.js builds OAuth/callback URLs from process.env.AUTH_URL (or NEXTAUTH_URL) only.
 * Setting `url` in auth.config does not change signIn() or /api/auth/* when those are unset.
 * Railway serves the process on an internal host (localhost:8080); copy the public origin here.
 */
export function syncAuthEnv(env: NodeJS.Dict<string> = process.env) {
  const origin = authOrigin(env);
  if (!origin) return origin;
  const current = parseEnvOrigin(env.AUTH_URL) ?? parseEnvOrigin(env.NEXTAUTH_URL);
  if (!current || (isLoopbackOrigin(current) && !isLoopbackOrigin(origin))) {
    env.AUTH_URL = origin;
  }
  return origin;
}

function parseEnvOrigin(raw: string | undefined) {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    return new URL(value.startsWith('http') ? value : `https://${value}`).origin;
  } catch {
    return undefined;
  }
}

syncAuthEnv();
