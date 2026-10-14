import {redirect} from 'next/navigation';
import {auth, signIn} from '@/auth';

export const dynamic = 'force-dynamic';

export default async function Login({searchParams}: {searchParams: Promise<{error?: string; callbackUrl?: string}>}) {
  const session = await auth();
  if (session?.user) redirect('/');
  const {error, callbackUrl} = await searchParams;
  const target = callbackUrl?.startsWith('/') && !callbackUrl.startsWith('//') ? callbackUrl : '/';
  const configured = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET && process.env.AUTH_SECRET && process.env.ALLOWED_EMAIL);

  return (
    <main className="login">
      <div className="brand">
        ✦ <strong>Deevaa OS</strong>
      </div>
      <h1>Sign in to your briefing</h1>
      <p className="muted">Deevaa is private to one owner account. Signing in shares only your name and email with this app; calendar access is requested separately.</p>
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
      {error && (
        <p className="warning" role="alert">
          Sign-in was not allowed. Only the configured owner account with a verified email can use Deevaa.
        </p>
      )}
    </main>
  );
}
