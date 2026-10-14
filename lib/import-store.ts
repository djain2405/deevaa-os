import {and, desc, eq, gte, sql} from 'drizzle-orm';
import type {ImportPreview} from './blueprint-import';
import {getDb} from './db/client';
import {blueprintImports, blueprintSuggestions, blueprintVersions} from './db/schema';

export async function countImportsSince(userId: string, since: Date) {
  const db = await getDb();
  const [row] = await db
    .select({n: sql<number>`count(*)::int`})
    .from(blueprintImports)
    .where(and(eq(blueprintImports.userId, userId), gte(blueprintImports.createdAt, since)));
  return Number(row?.n ?? 0);
}

export async function findAppliedImport(userId: string, contentSha256: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(blueprintImports)
    .where(and(eq(blueprintImports.userId, userId), eq(blueprintImports.contentSha256, contentSha256), eq(blueprintImports.status, 'applied')))
    .limit(1);
  return row ?? null;
}

export async function upsertImportPreview(input: {
  userId: string;
  sourceName: string;
  contentSha256: string;
  previewSha256: string;
  preview: ImportPreview;
}) {
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(blueprintImports)
    .where(and(eq(blueprintImports.userId, input.userId), eq(blueprintImports.contentSha256, input.contentSha256)))
    .limit(1);
  if (existing) {
    const [row] = await db
      .update(blueprintImports)
      .set({
        sourceName: input.sourceName,
        previewSha256: input.previewSha256,
        preview: input.preview,
        status: 'preview',
        applyReport: null,
        appliedAt: null
      })
      .where(eq(blueprintImports.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await db
    .insert(blueprintImports)
    .values({
      userId: input.userId,
      sourceName: input.sourceName,
      contentSha256: input.contentSha256,
      previewSha256: input.previewSha256,
      preview: input.preview,
      status: 'preview'
    })
    .returning();
  return row!;
}

/** @deprecated use upsertImportPreview */
export const createImportPreview = upsertImportPreview;

export async function getImportPreview(userId: string, id: string) {
  const db = await getDb();
  const [row] = await db.select().from(blueprintImports).where(and(eq(blueprintImports.userId, userId), eq(blueprintImports.id, id))).limit(1);
  return row ?? null;
}

export async function markImportApplied(userId: string, id: string, report: Record<string, unknown>) {
  const db = await getDb();
  const [row] = await db
    .update(blueprintImports)
    .set({status: 'applied', appliedAt: new Date(), applyReport: report})
    .where(and(eq(blueprintImports.userId, userId), eq(blueprintImports.id, id), eq(blueprintImports.status, 'preview')))
    .returning();
  return row ?? null;
}

export async function cancelImportPreview(userId: string, id: string) {
  const db = await getDb();
  const [row] = await db
    .update(blueprintImports)
    .set({status: 'canceled'})
    .where(and(eq(blueprintImports.userId, userId), eq(blueprintImports.id, id), eq(blueprintImports.status, 'preview')))
    .returning();
  return row ?? null;
}

export async function listImportHistory(userId: string, limit = 10) {
  const db = await getDb();
  return db.select().from(blueprintImports).where(eq(blueprintImports.userId, userId)).orderBy(desc(blueprintImports.createdAt)).limit(limit);
}

export async function wipeBlueprintData(userId: string) {
  const db = await getDb();
  await db.delete(blueprintSuggestions).where(eq(blueprintSuggestions.userId, userId));
  await db.delete(blueprintVersions).where(eq(blueprintVersions.userId, userId));
  await db.delete(blueprintImports).where(eq(blueprintImports.userId, userId));
}
