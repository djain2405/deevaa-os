import {NextResponse} from 'next/server';
import {appOrigin} from '@/lib/auth-url';
import {verifyState} from '@/lib/crypto';
import {completeGmailAuthorization, GMAIL_STATE_COOKIE, GmailError} from '@/lib/google-gmail';
import {safeEqual, unauthorized} from '@/lib/http';
import {logEvent} from '@/lib/log';
import {getSessionUser} from '@/lib/session';
import {audit} from '@/lib/store';

export const dynamic = 'force-dynamic';

function readCookie(req: Request, name: string) {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  const done = (result: string) => {
    const res = NextResponse.redirect(new URL(`/?gmail=${result}`, appOrigin(req)), 303);
    res.headers.set('Cache-Control', 'private, no-store');
    res.cookies.set(GMAIL_STATE_COOKIE, '', {path: '/api/google/gmail', maxAge: 0});
    return res;
  };

  if (url.searchParams.get('error')) {
    await audit(user.id, 'gmail.connect', 'denied', {reason: 'user_denied'});
    return done('denied');
  }
  const state = verifyState<{uid: string; nonce: string; exp: number}>(url.searchParams.get('state') ?? '');
  const nonce = readCookie(req, GMAIL_STATE_COOKIE);
  const code = url.searchParams.get('code');
  if (!state || !nonce || !code || state.uid !== user.id || state.exp < Date.now() || !safeEqual(state.nonce, nonce)) {
    await audit(user.id, 'gmail.connect', 'denied', {reason: 'bad_state'});
    return done('invalid_state');
  }

  try {
    await completeGmailAuthorization(user.id, code);
    await audit(user.id, 'gmail.connect', 'ok');
    return done('connected');
  } catch (e) {
    const kind = e instanceof GmailError ? e.kind : 'unavailable';
    logEvent('error', 'gmail.callback', {kind});
    await audit(user.id, 'gmail.connect', 'error', {kind});
    return done(kind);
  }
}
