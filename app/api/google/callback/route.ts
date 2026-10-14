import {NextResponse} from 'next/server';
import {safeEqual, unauthorized} from '@/lib/http';
import {verifyState} from '@/lib/crypto';
import {completeAuthorization, GoogleError, STATE_COOKIE} from '@/lib/google-calendar';
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
    const res = NextResponse.redirect(new URL(`/?calendar=${result}`, url.origin), 303);
    res.headers.set('Cache-Control', 'private, no-store');
    res.cookies.set(STATE_COOKIE, '', {path: '/api/google', maxAge: 0});
    return res;
  };

  if (url.searchParams.get('error')) {
    await audit(user.id, 'google.connect', 'denied', {reason: 'user_denied'});
    return done('denied');
  }
  const state = verifyState<{uid: string; nonce: string; exp: number}>(url.searchParams.get('state') ?? '');
  const nonce = readCookie(req, STATE_COOKIE);
  const code = url.searchParams.get('code');
  if (!state || !nonce || !code || state.uid !== user.id || state.exp < Date.now() || !safeEqual(state.nonce, nonce)) {
    await audit(user.id, 'google.connect', 'denied', {reason: 'bad_state'});
    return done('invalid_state');
  }

  try {
    const {calendarCount} = await completeAuthorization(user.id, code);
    await audit(user.id, 'google.connect', 'ok', {calendars: calendarCount});
    return done('connected');
  } catch (e) {
    const kind = e instanceof GoogleError ? e.kind : 'unavailable';
    logEvent('error', 'gcal.callback', {kind});
    await audit(user.id, 'google.connect', 'error', {kind});
    return done(kind);
  }
}
