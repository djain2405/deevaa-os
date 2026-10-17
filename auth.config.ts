import './lib/sync-auth-env';
import type {NextAuthConfig} from 'next-auth';
import Google from 'next-auth/providers/google';
import {authOrigin} from './lib/auth-url';

export function isAllowedEmail(email: unknown) {
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase();
  return Boolean(allowed) && typeof email === 'string' && email.trim().toLowerCase() === allowed;
}

const googleId = process.env.AUTH_GOOGLE_ID?.trim();
const googleSecret = process.env.AUTH_GOOGLE_SECRET?.trim();
const origin = authOrigin();

/** Edge-safe config shared by middleware and the Node auth handler. Login requests identity scopes only. */
export const authConfig = {
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  ...(origin ? {url: origin} : {}),
  session: {strategy: 'jwt', maxAge: 7 * 24 * 60 * 60},
  pages: {signIn: '/login', error: '/login'},
  providers: [
    Google({
      clientId: googleId ?? '',
      clientSecret: googleSecret ?? '',
      authorization: {params: {scope: 'openid email profile', prompt: 'select_account'}}
    })
  ],
  callbacks: {
    signIn({profile}) {
      return profile?.email_verified === true && isAllowedEmail(profile.email);
    },
    jwt({token}) {
      return token;
    },
    session({session}) {
      return session;
    }
  }
} satisfies NextAuthConfig;
