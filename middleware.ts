import NextAuth from 'next-auth';
import {NextResponse} from 'next/server';
import {authConfig, isAllowedEmail} from './auth.config';
import {isPublicPath} from './lib/public-paths';

const {auth} = NextAuth(authConfig);

export default auth((req) => {
  const {pathname, search} = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (req.auth?.user && isAllowedEmail(req.auth.user.email)) return NextResponse.next();
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      {error: {code: 'unauthorized', message: 'Sign in to continue.'}},
      {status: 401, headers: {'Cache-Control': 'private, no-store'}}
    );
  }
  const login = new URL('/login', req.nextUrl.origin);
  login.searchParams.set('callbackUrl', `${pathname}${search}`);
  return NextResponse.redirect(login);
});

export const config = {matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']};
