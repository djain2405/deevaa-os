import type {ReactNode} from 'react';
import {redirect} from 'next/navigation';
import {auth, signOut} from '@/auth';
import {OsNav} from '@/app/os-nav';

export const dynamic = 'force-dynamic';

export default async function OsLayout({children}: {children: ReactNode}) {
  const session = await auth();
  if (!session?.user?.email) redirect('/login');
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <main>
        <header>
          <div className="brand">
            ✦ <strong>Deevaa OS</strong>
            <span>Workspace</span>
          </div>
          <form
            action={async () => {
              'use server';
              await signOut({redirectTo: '/login'});
            }}
          >
            <button type="submit" className="ghost">
              Sign out
            </button>
          </form>
        </header>
        <OsNav />
        <div id="content">{children}</div>
      </main>
    </>
  );
}
