import {and, desc, eq, gte, notInArray, sql} from 'drizzle-orm';
import {correlationFromRequest} from './correlation';
import {randomUUID} from 'node:crypto';
import {getDb} from './db/client';
import {auditEvents, briefings, locks, oauthCredentials, runs, users} from './db/schema';

export type RunRow = typeof runs.$inferSelect;
export type BriefingRow = typeof briefings.$inferSelect;
export type CredentialRow = typeof oauthCredentials.$inferSelect;

export async function getOrCreateUser(email: string) {
  const db = await getDb();
  const normalized = email.trim().toLowerCase();
  await db.insert(users).values({email: normalized}).onConflictDoNothing({target: users.email});
  const [row] = await db.select().from(users).where(eq(users.email, normalized));
  return row;
}

export async function audit(
  userId: string | null,
  action: string,
  result: 'ok' | 'denied' | 'error' | 'duplicate',
  detail: Record<string, string | number | boolean | null> = {}
) {
  const db = await getDb();
  const correlationId = await correlationFromRequest();
  await db.insert(auditEvents).values({userId, action, result, detail, correlationId});
}

export async function listAudit(userId: string, limit = 50) {
  const db = await getDb();
  return db.select().from(auditEvents).where(eq(auditEvents.userId, userId)).orderBy(desc(auditEvents.createdAt)).limit(limit);
}

export async function getCredential(userId: string, provider: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(oauthCredentials)
    .where(and(eq(oauthCredentials.userId, userId), eq(oauthCredentials.provider, provider)));
  return row ?? null;
}

export async function saveCredential(input: {
  userId: string;
  provider: string;
  encryptedRefreshToken: string;
  scope: string;
  calendarIds: string[];
}) {
  const db = await getDb();
  const now = new Date();
  await db
    .insert(oauthCredentials)
    .values({...input, status: 'active', updatedAt: now})
    .onConflictDoUpdate({
      target: [oauthCredentials.userId, oauthCredentials.provider],
      set: {
        encryptedRefreshToken: input.encryptedRefreshToken,
        scope: input.scope,
        calendarIds: input.calendarIds,
        status: 'active',
        updatedAt: now
      }
    });
}

export async function markCredentialRevoked(userId: string, provider: string) {
  const db = await getDb();
  await db
    .update(oauthCredentials)
    .set({status: 'revoked', updatedAt: new Date()})
    .where(and(eq(oauthCredentials.userId, userId), eq(oauthCredentials.provider, provider)));
}

export async function deleteCredential(userId: string, provider: string) {
  const db = await getDb();
  await db.delete(oauthCredentials).where(and(eq(oauthCredentials.userId, userId), eq(oauthCredentials.provider, provider)));
}

export async function acquireLock(key: string, ttlMs: number) {
  const db = await getDb();
  const owner = randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs);
  const rows = await db
    .insert(locks)
    .values({key, owner, expiresAt})
    .onConflictDoUpdate({target: locks.key, set: {owner, expiresAt}, setWhere: sql`${locks.expiresAt} < now()`})
    .returning({owner: locks.owner});
  return rows[0]?.owner === owner ? owner : null;
}

export async function releaseLock(key: string, owner: string) {
  const db = await getDb();
  await db.delete(locks).where(and(eq(locks.key, key), eq(locks.owner, owner)));
}

/**
 * Claims an idempotency key. Returns `claimed` for a new or retried run, `duplicate` when the key already
 * succeeded or is still running.
 */
export async function claimRun(input: {
  userId: string;
  localDate: string;
  trigger: RunRow['trigger'];
  idempotencyKey: string;
}): Promise<{outcome: 'claimed' | 'duplicate'; run: RunRow}> {
  const db = await getDb();
  const inserted = await db
    .insert(runs)
    .values({...input, status: 'running'})
    .onConflictDoNothing({target: runs.idempotencyKey})
    .returning();
  if (inserted[0]) return {outcome: 'claimed', run: inserted[0]};

  const retried = await db
    .update(runs)
    .set({status: 'running', attempts: sql`${runs.attempts} + 1`, errorCode: null, startedAt: new Date(), finishedAt: null})
    .where(and(eq(runs.idempotencyKey, input.idempotencyKey), eq(runs.status, 'failed')))
    .returning();
  if (retried[0]) return {outcome: 'claimed', run: retried[0]};

  const [existing] = await db.select().from(runs).where(eq(runs.idempotencyKey, input.idempotencyKey));
  return {outcome: 'duplicate', run: existing};
}

export async function finishRun(runId: string, result: {status: 'succeeded' | 'failed'; errorCode?: string; briefingId?: string}) {
  const db = await getDb();
  const [row] = await db
    .update(runs)
    .set({status: result.status, errorCode: result.errorCode ?? null, briefingId: result.briefingId ?? null, finishedAt: new Date()})
    .where(eq(runs.id, runId))
    .returning();
  return row;
}

export async function latestRun(userId: string, localDate: string, opts?: {excludeTriggers?: RunRow['trigger'][]}) {
  const db = await getDb();
  const conds = [eq(runs.userId, userId), eq(runs.localDate, localDate)];
  if (opts?.excludeTriggers?.length) conds.push(notInArray(runs.trigger, opts.excludeTriggers));
  const [row] = await db
    .select()
    .from(runs)
    .where(and(...conds))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return row ?? null;
}

export async function countRunsSince(userId: string, trigger: RunRow['trigger'], since: Date) {
  const db = await getDb();
  const [row] = await db
    .select({n: sql<number>`count(*)::int`})
    .from(runs)
    .where(and(eq(runs.userId, userId), eq(runs.trigger, trigger), gte(runs.startedAt, since)));
  return Number(row?.n ?? 0);
}

export async function listRuns(userId: string, localDate: string) {
  const db = await getDb();
  return db.select().from(runs).where(and(eq(runs.userId, userId), eq(runs.localDate, localDate))).orderBy(desc(runs.startedAt));
}

export async function getRunByKey(idempotencyKey: string) {
  const db = await getDb();
  const [row] = await db.select().from(runs).where(eq(runs.idempotencyKey, idempotencyKey));
  return row ?? null;
}

export async function upsertBriefing(input: {
  userId: string;
  localDate: string;
  version: number;
  status: string;
  snapshot: unknown;
  runId: string;
  generatedAt: Date;
}) {
  const db = await getDb();
  const [row] = await db
    .insert(briefings)
    .values({...input, updatedAt: new Date()})
    .onConflictDoUpdate({
      target: [briefings.userId, briefings.localDate, briefings.version],
      set: {status: input.status, snapshot: input.snapshot, runId: input.runId, generatedAt: input.generatedAt, updatedAt: new Date()}
    })
    .returning();
  return row;
}

export async function getBriefing(userId: string, localDate: string, version: number) {
  const db = await getDb();
  const [exact] = await db
    .select()
    .from(briefings)
    .where(and(eq(briefings.userId, userId), eq(briefings.localDate, localDate), eq(briefings.version, version)));
  if (exact) return exact;
  const [latest] = await db
    .select()
    .from(briefings)
    .where(and(eq(briefings.userId, userId), eq(briefings.localDate, localDate)))
    .orderBy(desc(briefings.version))
    .limit(1);
  return latest ?? null;
}

export async function countBriefings(userId: string, localDate: string) {
  const db = await getDb();
  const [row] = await db
    .select({n: sql<number>`count(*)::int`})
    .from(briefings)
    .where(and(eq(briefings.userId, userId), eq(briefings.localDate, localDate)));
  return Number(row?.n ?? 0);
}

export async function getBlueprintNotionPageId(userId: string) {
  const db = await getDb();
  const [row] = await db.select({pageId: users.blueprintNotionPageId}).from(users).where(eq(users.id, userId));
  return row?.pageId ?? null;
}

export async function setBlueprintNotionPageId(userId: string, pageId: string) {
  const db = await getDb();
  await db.update(users).set({blueprintNotionPageId: pageId}).where(eq(users.id, userId));
}
