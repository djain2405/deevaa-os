import {readHeartbeat, recordHeartbeat} from '@/lib/extensions';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {getSessionUser} from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {workerId?: unknown; kind?: unknown; status?: unknown} | null;
  const workerId = typeof body?.workerId === 'string' ? body.workerId.slice(0, 80) : '';
  const kind = body?.kind === 'local' || body?.kind === 'cloud' ? body.kind : null;
  const status = typeof body?.status === 'string' ? body.status.slice(0, 40) : '';
  if (!workerId || !kind || !status) return apiError(400, 'bad_heartbeat', 'Send workerId, kind, and status.');
  await recordHeartbeat(user.id, workerId, kind, status);
  const row = await readHeartbeat(user.id, workerId);
  return privateJson({workerId: row?.workerId, kind: row?.kind, status: row?.status, seenAt: row?.seenAt});
}
