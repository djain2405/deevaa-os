import {randomBytes} from 'node:crypto';
import {NextResponse} from 'next/server';
import {signState} from '@/lib/crypto';
import {buildGmailAuthUrl, GMAIL_STATE_COOKIE} from '@/lib/google-gmail';
import {forbiddenOrigin, isSameOrigin, unauthorized} from '@/lib/http';
import {logEvent} from '@/lib/log';
import {getSessionUser} from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const appUrl = new URL(req.url).origin;
  try {
    const nonce = randomBytes(16).toString('base64url');
    const state = signState({uid: user.id, nonce, exp: Date.now() + 10 * 60 * 1000});
    const res = NextResponse.redirect(buildGmailAuthUrl(state, user.email), 303);
    res.headers.set('Cache-Control', 'private, no-store');
    res.cookies.set(GMAIL_STATE_COOKIE, nonce, {
      httpOnly: true,
      secure: appUrl.startsWith('https://'),
      sameSite: 'lax',
      path: '/api/google/gmail',
      maxAge: 600
    });
    return res;
  } catch (e) {
    logEvent('error', 'gmail.connect', {kind: e instanceof Error ? e.name : 'unknown'});
    return NextResponse.redirect(new URL('/?gmail=config', appUrl), 303);
  }
}
