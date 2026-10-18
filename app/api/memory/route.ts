import {addMemory, deleteMemory, listMemory, reviseMemory, type MemoryPartition} from '@/lib/memory';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {getSessionUser} from '@/lib/session';

export const dynamic = 'force-dynamic';

const PARTITIONS = new Set(['episodic', 'fact', 'task_history', 'reflection']);

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  const partition = url.searchParams.get('partition');
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const rows = await listMemory(user.id, partition && PARTITIONS.has(partition) ? (partition as MemoryPartition) : undefined);
  const filtered = q ? rows.filter((row) => row.body.toLowerCase().includes(q)) : rows;
  return privateJson({memories: filtered.map((row) => ({id: row.id, partition: row.partition, body: row.body, provenance: row.provenance, confidence: row.confidence, consent: row.consent, updatedAt: row.updatedAt}))});
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {partition?: unknown; body?: unknown; provenance?: unknown; id?: unknown; op?: unknown} | null;
  if (body?.op === 'delete' && typeof body.id === 'string') {
    const row = await deleteMemory(user.id, body.id);
    if (!row) return apiError(404, 'missing_memory', 'That note is already gone.');
    return privateJson({deleted: true});
  }
  if (body?.op === 'revise' && typeof body.id === 'string' && typeof body.body === 'string') {
    const row = await reviseMemory(user.id, body.id, body.body);
    if (!row) return apiError(404, 'missing_memory', 'That note is already gone.');
    return privateJson({id: row.id, body: row.body});
  }
  const partition = typeof body?.partition === 'string' && PARTITIONS.has(body.partition) ? (body.partition as MemoryPartition) : null;
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!partition || !text) return apiError(400, 'bad_memory', 'Send a partition and a note.');
  const row = await addMemory({userId: user.id, partition, body: text, provenance: typeof body?.provenance === 'string' ? body.provenance : 'user'});
  return privateJson({id: row.id, partition: row.partition, consent: row.consent});
}
