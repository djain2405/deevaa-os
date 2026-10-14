import {and, asc, desc, eq, gte, sql} from 'drizzle-orm';
import {getDb} from './db/client';
import {actionFeedback, blueprintSuggestions, blueprintVersions, conversations, intakeOps, messages, permissions, type OpStatus} from './db/schema';

export type MessageRow = typeof messages.$inferSelect;
export type OpRow = typeof intakeOps.$inferSelect;
export type SuggestionRow = typeof blueprintSuggestions.$inferSelect;
export type FeedbackRow = typeof actionFeedback.$inferSelect;

export const NOTION_WRITE = 'notion_task_write';

export async function getPermission(userId: string, permission: string) {
  const db = await getDb();
  const [row] = await db.select().from(permissions).where(and(eq(permissions.userId, userId), eq(permissions.permission, permission)));
  return row ?? null;
}

export async function hasPermission(userId: string, permission: string) {
  return (await getPermission(userId, permission))?.status === 'granted';
}

export async function setPermission(userId: string, permission: string, status: 'granted' | 'revoked') {
  const db = await getDb();
  const now = new Date();
  const [row] = await db
    .insert(permissions)
    .values({userId, permission, status, updatedAt: now})
    .onConflictDoUpdate({target: [permissions.userId, permissions.permission], set: {status, updatedAt: now}})
    .returning();
  return row;
}

async function conversationFor(userId: string) {
  const db = await getDb();
  await db.insert(conversations).values({userId}).onConflictDoNothing({target: conversations.userId});
  const [row] = await db.select().from(conversations).where(eq(conversations.userId, userId));
  return row;
}

/** Returns `duplicate` with the stored row when this client key was already used. */
export async function insertUserMessage(userId: string, content: string, clientKey: string) {
  const db = await getDb();
  const convo = await conversationFor(userId);
  const [row] = await db
    .insert(messages)
    .values({conversationId: convo.id, userId, role: 'user', content, clientKey})
    .onConflictDoNothing({target: [messages.userId, messages.clientKey]})
    .returning();
  if (row) return {outcome: 'new' as const, message: row};
  const [existing] = await db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.clientKey, clientKey)));
  return {outcome: 'duplicate' as const, message: existing};
}

export async function insertAssistantMessage(userId: string, content: string, result: unknown, replyTo: string) {
  const db = await getDb();
  const convo = await conversationFor(userId);
  const [row] = await db
    .insert(messages)
    .values({conversationId: convo.id, userId, role: 'assistant', content, result, clientKey: `reply:${replyTo}`})
    .onConflictDoUpdate({target: [messages.userId, messages.clientKey], set: {content, result}})
    .returning();
  return row;
}

export async function getReply(userId: string, replyTo: string) {
  const db = await getDb();
  const [row] = await db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.clientKey, `reply:${replyTo}`)));
  return row ?? null;
}

export async function getMessage(userId: string, id: string) {
  const db = await getDb();
  const [row] = await db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.id, id)));
  return row ?? null;
}

export async function listMessages(userId: string, limit = 50) {
  const db = await getDb();
  const rows = await db.select().from(messages).where(eq(messages.userId, userId)).orderBy(desc(messages.createdAt), desc(messages.role)).limit(limit);
  return rows.reverse();
}

export async function countUserMessagesSince(userId: string, since: Date) {
  const db = await getDb();
  const [row] = await db
    .select({n: sql<number>`count(*)::int`})
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.role, 'user'), gte(messages.createdAt, since)));
  return Number(row?.n ?? 0);
}

/** Deletes chat text and pending suggestions. Operation records stay for audit and undo, without message links. */
export async function deleteConversation(userId: string) {
  const db = await getDb();
  await db.delete(blueprintSuggestions).where(and(eq(blueprintSuggestions.userId, userId), eq(blueprintSuggestions.status, 'pending')));
  await db.delete(conversations).where(eq(conversations.userId, userId));
}

/** Claims an operation key. A key that already succeeded, or was undone, is returned as-is and must not run again. */
export async function claimOp(input: {
  userId: string;
  messageId: string;
  opKey: string;
  kind: OpRow['kind'];
  title: string;
  fields: Record<string, unknown>;
  pageId?: string | null;
  status: 'proposed' | 'pending';
}) {
  const db = await getDb();
  const [row] = await db
    .insert(intakeOps)
    .values({...input, pageId: input.pageId ?? null})
    .onConflictDoNothing({target: intakeOps.opKey})
    .returning();
  if (row) return {outcome: 'claimed' as const, op: row};
  const [existing] = await db.select().from(intakeOps).where(eq(intakeOps.opKey, input.opKey));
  if (input.status === 'proposed' || existing.status === 'succeeded' || existing.status === 'undone') return {outcome: 'existing' as const, op: existing};
  const [retried] = await db
    .update(intakeOps)
    .set({status: 'pending', errorCode: null, updatedAt: new Date()})
    .where(eq(intakeOps.id, existing.id))
    .returning();
  return {outcome: 'claimed' as const, op: retried};
}

export async function updateOp(
  id: string,
  patch: Partial<Pick<OpRow, 'status' | 'pageId' | 'pageUrl' | 'before' | 'afterEditedAt' | 'errorCode' | 'title'>> & {status: OpStatus}
) {
  const db = await getDb();
  const [row] = await db.update(intakeOps).set({...patch, updatedAt: new Date()}).where(eq(intakeOps.id, id)).returning();
  return row;
}

export async function opsForMessage(userId: string, messageId: string) {
  const db = await getDb();
  return db.select().from(intakeOps).where(and(eq(intakeOps.userId, userId), eq(intakeOps.messageId, messageId))).orderBy(asc(intakeOps.opKey));
}

export async function listOps(userId: string, limit = 50) {
  const db = await getDb();
  return db.select().from(intakeOps).where(eq(intakeOps.userId, userId)).orderBy(desc(intakeOps.updatedAt)).limit(limit);
}

export async function addSuggestions(userId: string, messageId: string, items: {kind: string; text: string}[]) {
  if (!items.length) return [];
  const db = await getDb();
  return db.insert(blueprintSuggestions).values(items.map((i) => ({userId, messageId, kind: i.kind, text: i.text}))).returning();
}

export async function listSuggestions(userId: string, status: SuggestionRow['status'] = 'pending') {
  const db = await getDb();
  return db
    .select()
    .from(blueprintSuggestions)
    .where(and(eq(blueprintSuggestions.userId, userId), eq(blueprintSuggestions.status, status)))
    .orderBy(desc(blueprintSuggestions.createdAt))
    .limit(50);
}

export async function suggestionsForMessage(userId: string, messageId: string) {
  const db = await getDb();
  return db.select().from(blueprintSuggestions).where(and(eq(blueprintSuggestions.userId, userId), eq(blueprintSuggestions.messageId, messageId)));
}

export async function resolveSuggestion(userId: string, id: string, status: 'confirmed' | 'dismissed') {
  const db = await getDb();
  const [row] = await db
    .update(blueprintSuggestions)
    .set({status, updatedAt: new Date()})
    .where(and(eq(blueprintSuggestions.userId, userId), eq(blueprintSuggestions.id, id), eq(blueprintSuggestions.status, 'pending')))
    .returning();
  return row ?? null;
}

export async function latestBlueprint(userId: string) {
  const db = await getDb();
  const [row] = await db.select().from(blueprintVersions).where(eq(blueprintVersions.userId, userId)).orderBy(desc(blueprintVersions.version)).limit(1);
  return row ?? null;
}

/** Appends a version; `expectedVersion` rejects edits made against a stale copy. */
export async function saveBlueprint(userId: string, data: unknown, expectedVersion: number) {
  const db = await getDb();
  const current = await latestBlueprint(userId);
  if ((current?.version ?? 0) !== expectedVersion) return null;
  const [row] = await db
    .insert(blueprintVersions)
    .values({userId, version: expectedVersion + 1, data})
    .onConflictDoNothing({target: [blueprintVersions.userId, blueprintVersions.version]})
    .returning();
  return row ?? null;
}

export async function addFeedback(input: Omit<typeof actionFeedback.$inferInsert, 'id' | 'createdAt'>) {
  const db = await getDb();
  const [row] = await db.insert(actionFeedback).values(input).returning();
  return row;
}

export async function recentFeedback(userId: string, since: Date) {
  const db = await getDb();
  return db
    .select()
    .from(actionFeedback)
    .where(and(eq(actionFeedback.userId, userId), gte(actionFeedback.createdAt, since)))
    .orderBy(desc(actionFeedback.createdAt))
    .limit(200);
}

export async function countFeedbackSince(userId: string, since: Date) {
  const db = await getDb();
  const [row] = await db
    .select({n: sql<number>`count(*)::int`})
    .from(actionFeedback)
    .where(and(eq(actionFeedback.userId, userId), gte(actionFeedback.createdAt, since)));
  return Number(row?.n ?? 0);
}