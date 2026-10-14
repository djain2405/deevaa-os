import type {NextAuthConfig} from 'next-auth';
import Google from 'next-auth/providers/google';

export function isAllowedEmail(email: unknown) {
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase();
  return Boolean(allowed) && typeof email === 'string' && email.trim().toLowerCase() === allowed;
}

/** Edge-safe config shared by middleware and the Node auth handler. Login requests identity scopes only. */
export const authConfig = {
  trustHost: true,
  session: {strategy: 'jwt', maxAge: 7 * 24 * 60 * 60},
  pages: {signIn: '/login', error: '/login'},
  providers: [Google({authorization: {params: {scope: 'openid email profile', prompt: 'select_account'}}})],
  callbacks: {
    signIn({profile}) {
      return profile?.email_verified === true && isAllowedEmail(profile.email);
    },
    jwt({token}) {
      return isAllowedEmail(token.email) ? token : null;
    },
    session({session}) {
      return session;
    }
  }
} satisfies NextAuthConfig;
