import {deleteAccount, exportAccount} from '@/lib/account';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {getSessionUser} from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const data = await exportAccount(user.id);
  const serialized = JSON.stringify(data);
  if (/encrypted_refresh_token|refresh_token|TOKEN_ENCRYPTION/i.test(serialized)) {
    return apiError(500, 'export_blocked', 'Export was blocked because it contained credential material.');
  }
  return privateJson(data);
}

export async function DELETE(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {confirm?: unknown} | null;
  if (body?.confirm !== 'delete-my-data') return apiError(400, 'confirm', 'Type delete-my-data to remove Deevaa data. Notion pages are not deleted.');
  await deleteAccount(user.id);
  return privateJson({deleted: true, notion: 'kept'});
}
