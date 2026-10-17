import {GMAIL_PROVIDER, revokeGmailAndForget} from '@/lib/google-gmail';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {getSessionUser} from '@/lib/session';
import {audit, deleteCredential} from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  try {
    await revokeGmailAndForget(user.id);
    await deleteCredential(user.id, GMAIL_PROVIDER);
    await audit(user.id, 'gmail.disconnect', 'ok');
    return privateJson({ok: true});
  } catch {
    return apiError(500, 'internal', 'Could not disconnect Gmail.');
  }
}
