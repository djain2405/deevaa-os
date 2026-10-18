import {and, eq} from 'drizzle-orm';
import {getDb} from './db/client';
import {syncCursors} from './db/schema';

export async function getSyncCursor(userId: string, connector: string) {
  const db = await getDb();
  const [row] = await db.select().from(syncCursors).where(and(eq(syncCursors.userId, userId), eq(syncCursors.connector, connector)));
  return row ?? null;
}

export async function saveSyncCursor(userId: string, connector: string, cursor: string) {
  const db = await getDb();
  await db
    .insert(syncCursors)
    .values({userId, connector, cursor, updatedAt: new Date()})
    .onConflictDoUpdate({target: [syncCursors.userId, syncCursors.connector], set: {cursor, updatedAt: new Date()}});
}
