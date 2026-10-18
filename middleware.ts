import {NextResponse} from 'next/server';
import {auth} from './auth';
import {isAllowedEmail} from './auth.config';
import {isPublicPath} from './lib/public-paths';

export default auth((req) => {
  const id = req.headers.get('x-correlation-id') || crypto.randomUUID();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-correlation-id', id);
  const {pathname, search} = req.nextUrl;
  const stamp = (res: NextResponse) => {
    res.headers.set('x-correlation-id', id);
    return res;
  };
  if (isPublicPath(pathname)) return stamp(NextResponse.next({request: {headers: requestHeaders}}));
  if (req.auth?.user && isAllowedEmail(req.auth.user.email)) return stamp(NextResponse.next({request: {headers: requestHeaders}}));
  if (pathname.startsWith('/api/')) {
    return stamp(
      NextResponse.json(
        {error: {code: 'unauthorized', message: 'Sign in to continue.'}},
        {status: 401, headers: {'Cache-Control': 'private, no-store'}}
      )
    );
  }
  const login = new URL('/login', req.nextUrl.origin);
  login.searchParams.set('callbackUrl', `${pathname}${search}`);
  return stamp(NextResponse.redirect(login));
});

export const config = {matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']};
