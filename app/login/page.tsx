import {redirect} from 'next/navigation';
import {auth, signIn} from '@/auth';
import {authOrigin} from '@/lib/auth-url';

export const dynamic = 'force-dynamic';

export default async function Login({searchParams}: {searchParams: Promise<{error?: string; callbackUrl?: string}>}) {
  const session = await auth();
  if (session?.user) redirect('/');
  const {error, callbackUrl} = await searchParams;
  const target = callbackUrl?.startsWith('/') && !callbackUrl.startsWith('//') ? callbackUrl : '/';
  const secretOk = Boolean(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16);
  const configured = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET && secretOk && process.env.ALLOWED_EMAIL);
  const ownerEmail = process.env.ALLOWED_EMAIL?.trim();
  const origin = authOrigin();

  return (
    <main className="login">
      <div className="brand">
        ✦ <strong>Deevaa OS</strong>
      </div>
      <h1>Sign in to your briefing</h1>
      <p className="muted">
        Deevaa is private to one owner account{ownerEmail ? ` (${ownerEmail})` : ''}. Signing in shares only your name and email with this app; calendar access is requested separately.
      </p>
      {configured ? (
        <form
          action={async () => {
            'use server';
            await signIn('google', {redirectTo: target});
          }}
        >
          <button className="cta" type="submit">
            Continue with Google
          </button>
        </form>
      ) : (
        <p className="warning" role="alert">
          Sign-in is not configured yet. Set AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET and ALLOWED_EMAIL, then restart the server.
        </p>
      )}
      {error === 'Configuration' && (
        <p className="warning" role="alert">
          Sign-in hit a server configuration error. Confirm Google redirect URIs include{' '}
          <code>{origin || 'https://YOUR_DOMAIN'}/api/auth/callback/google</code>
          {!origin ? (
            <>
              , and set <code>APP_URL</code> on Railway to the public https origin (no trailing slash).
            </>
          ) : null}
        </p>
      )}
      {error && error !== 'Configuration' && (
        <p className="warning" role="alert">
          Sign-in was not allowed. Use the Google account{ownerEmail ? ` ${ownerEmail}` : ''} with a verified email, or pick that account on the Google chooser if you use several.
        </p>
      )}
    </main>
  );
}
