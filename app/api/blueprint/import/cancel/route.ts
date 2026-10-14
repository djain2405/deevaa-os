import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {cancelImportPreview} from '@/lib/import-store';
import {getSessionUser} from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {id?: unknown} | null;
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError(400, 'bad_request', 'Send the preview id.');
  const row = await cancelImportPreview(user.id, id);
  if (!row) return apiError(404, 'not_found', 'That preview was already applied or canceled.');
  return privateJson({canceled: true});
}
