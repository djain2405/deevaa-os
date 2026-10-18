import {and, desc, eq, isNull} from 'drizzle-orm';
import {getDb} from './db/client';
import {memoryRecords} from './db/schema';

export type MemoryPartition = 'episodic' | 'fact' | 'task_history' | 'reflection';

const WORK_AGENTS = new Set(['gmail.morning', 'consultancy', 'open.source', 'gde.research', 'project.manager', 'chief.of.staff']);

export async function addMemory(input: {userId: string; partition: MemoryPartition; body: string; provenance: string; confidence?: 'stated' | 'inferred'; consent?: 'private' | 'work_ok'}) {
  const db = await getDb();
  const [row] = await db
    .insert(memoryRecords)
    .values({
      userId: input.userId,
      partition: input.partition,
      body: input.body.slice(0, 4000),
      provenance: input.provenance.slice(0, 200),
      confidence: input.confidence ?? 'stated',
      consent: input.partition === 'reflection' ? 'private' : input.consent ?? 'private'
    })
    .returning();
  return row;
}

export async function listMemory(userId: string, partition?: MemoryPartition) {
  const db = await getDb();
  const rows = await db.select().from(memoryRecords).where(eq(memoryRecords.userId, userId)).orderBy(desc(memoryRecords.createdAt));
  return rows.filter((row) => !row.deletedAt && (!partition || row.partition === partition));
}

export async function reviseMemory(userId: string, id: string, body: string) {
  const db = await getDb();
  const [row] = await db
    .update(memoryRecords)
    .set({body: body.slice(0, 4000), updatedAt: new Date()})
    .where(and(eq(memoryRecords.id, id), eq(memoryRecords.userId, userId), isNull(memoryRecords.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteMemory(userId: string, id: string) {
  const db = await getDb();
  const [row] = await db
    .update(memoryRecords)
    .set({deletedAt: new Date(), body: '[deleted]'})
    .where(and(eq(memoryRecords.id, id), eq(memoryRecords.userId, userId)))
    .returning();
  return row ?? null;
}

/** Work agents never receive reflection text, even if someone asks for “all context”. */
export async function contextForAgent(userId: string, agentId: string) {
  const rows = await listMemory(userId);
  return rows.filter((row) => {
    if (row.partition === 'reflection') return false;
    if (row.consent !== 'work_ok' && WORK_AGENTS.has(agentId)) return false;
    if ((agentId === 'consultancy' || agentId === 'open.source' || agentId === 'gmail.morning') && row.partition !== 'fact' && row.partition !== 'task_history') return false;
    return true;
  });
}
