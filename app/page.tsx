import {redirect} from 'next/navigation';
import {auth, signOut} from '@/auth';
import Dashboard from './dashboard';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const session = await auth();
  if (!session?.user?.email) redirect('/login');
  return (
    <Dashboard
      email={session.user.email}
      signOutAction={async () => {
        'use server';
        await signOut({redirectTo: '/login'});
      }}
    />
  );
}
