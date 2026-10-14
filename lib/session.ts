import {auth} from '@/auth';
import {isAllowedEmail} from '@/auth.config';
import {getOrCreateUser} from './store';

export type SessionUser = {id: string; email: string};

/** Route handlers call this even though middleware already gates them. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !isAllowedEmail(email)) return null;
  const user = await getOrCreateUser(email);
  return {id: user.id, email: user.email};
}
