import {PROVIDER, revokeAndForget} from '@/lib/google-calendar';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {getSessionUser} from '@/lib/session';
import {audit, deleteCredential} from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  try {
    await revokeAndForget(user.id);
    await deleteCredential(user.id, PROVIDER);
    await audit(user.id, 'google.disconnect', 'ok');
    return privateJson({ok: true});
  } catch {
    return apiError(500, 'internal', 'Could not disconnect Google Calendar.');
  }
}
