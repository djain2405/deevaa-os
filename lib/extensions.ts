import {and, eq} from 'drizzle-orm';
import {getDb} from './db/client';
import {calendarBlocks, workerHeartbeats} from './db/schema';

/** Local planning blocks. They are not written to Google Calendar. */
export async function proposeNativeBlock(userId: string, input: {title: string; start: Date; end: Date}) {
  if (input.end <= input.start) throw new Error('Block end must be after the start.');
  const db = await getDb();
  const [row] = await db.insert(calendarBlocks).values({userId, title: input.title.slice(0, 160), start: input.start, endsAt: input.end, source: 'deevaa', status: 'proposed'}).returning();
  return row;
}

export async function listNativeBlocks(userId: string) {
  const db = await getDb();
  return db.select().from(calendarBlocks).where(eq(calendarBlocks.userId, userId));
}

export async function recordHeartbeat(userId: string, workerId: string, kind: 'cloud' | 'local', status: string) {
  const db = await getDb();
  const [row] = await db
    .insert(workerHeartbeats)
    .values({workerId, userId, kind, status, seenAt: new Date()})
    .onConflictDoUpdate({target: workerHeartbeats.workerId, set: {userId, kind, status, seenAt: new Date()}})
    .returning();
  return row;
}

export async function readHeartbeat(userId: string, workerId: string) {
  const db = await getDb();
  const [row] = await db.select().from(workerHeartbeats).where(and(eq(workerHeartbeats.workerId, workerId), eq(workerHeartbeats.userId, userId)));
  return row ?? null;
}
