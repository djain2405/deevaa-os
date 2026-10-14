import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {getPermission, NOTION_WRITE, setPermission} from '@/lib/intake-store';
import {getSessionUser} from '@/lib/session';
import {audit} from '@/lib/store';

export const dynamic = 'force-dynamic';

/** Only low-risk internal task writes can be granted standing permission. Everything external needs per-action approval. */
const GRANTABLE = new Set([NOTION_WRITE]);

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const row = await getPermission(user.id, NOTION_WRITE);
  return privateJson({permissions: {[NOTION_WRITE]: {status: row?.status ?? 'revoked', updatedAt: row?.updatedAt.toISOString() ?? null}}});
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {permission?: unknown; status?: unknown} | null;
  const permission = typeof body?.permission === 'string' ? body.permission : '';
  const status = body?.status;
  if (!GRANTABLE.has(permission)) return apiError(400, 'bad_permission', 'That permission cannot be granted from here.');
  if (status !== 'granted' && status !== 'revoked') return apiError(400, 'bad_status', 'Status must be granted or revoked.');
  const row = await setPermission(user.id, permission, status);
  await audit(user.id, 'permission.change', 'ok', {permission, status});
  return privateJson({permission, status: row.status, updatedAt: row.updatedAt.toISOString()});
}
