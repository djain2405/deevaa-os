import {eq} from 'drizzle-orm';
import {getDb} from './db/client';
import {
  agentRuns,
  approvalRequests,
  auditEvents,
  blueprintVersions,
  lifeAreas,
  memoryRecords,
  oauthCredentials,
  runs,
  users,
  userSettings
} from './db/schema';
import {revokeAndForget} from './google-calendar';
import {revokeGmailAndForget} from './google-gmail';
import {audit} from './store';

/** Owner export. Encrypted tokens and raw provider payloads are never included. */
export async function exportAccount(userId: string) {
  const db = await getDb();
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  const areas = await db.select().from(lifeAreas).where(eq(lifeAreas.userId, userId));
  const credentials = await db.select().from(oauthCredentials).where(eq(oauthCredentials.userId, userId));
  const blueprints = await db.select().from(blueprintVersions).where(eq(blueprintVersions.userId, userId));
  const runRows = await db.select().from(runs).where(eq(runs.userId, userId));
  const agent = await db.select().from(agentRuns).where(eq(agentRuns.userId, userId));
  const approvals = await db.select().from(approvalRequests).where(eq(approvalRequests.userId, userId));
  const memories = await db.select().from(memoryRecords).where(eq(memoryRecords.userId, userId));
  const auditRows = await db.select().from(auditEvents).where(eq(auditEvents.userId, userId));
  return {
    exportedAt: new Date().toISOString(),
    settings: settings ?? null,
    lifeAreas: areas,
    connections: credentials.map((c) => ({provider: c.provider, scope: c.scope, status: c.status, updatedAt: c.updatedAt})),
    blueprints: blueprints.map((b) => ({version: b.version, data: b.data, createdAt: b.createdAt})),
    runs: runRows.map((r) => ({id: r.id, localDate: r.localDate, trigger: r.trigger, status: r.status, errorCode: r.errorCode})),
    agentRuns: agent.map((r) => ({id: r.id, agentId: r.agentId, status: r.status, error: r.error})),
    approvals: approvals.map((a) => ({id: a.id, action: a.action, risk: a.risk, status: a.status, payloadHash: a.payloadHash})),
    memories: memories.filter((m) => !m.deletedAt).map((m) => ({id: m.id, partition: m.partition, body: m.body, consent: m.consent})),
    audit: auditRows.map((a) => ({action: a.action, result: a.result, correlationId: a.correlationId, createdAt: a.createdAt}))
  };
}

/** Deletes Deevaa execution data. Notion pages are left in place. */
export async function deleteAccount(userId: string) {
  try {
    await revokeGmailAndForget(userId);
  } catch {
    /* Revocation is best-effort; the local row still goes away with the user. */
  }
  try {
    await revokeAndForget(userId);
  } catch {
    /* Same as Gmail. */
  }
  await audit(userId, 'account.delete', 'ok', {});
  const db = await getDb();
  await db.delete(users).where(eq(users.id, userId));
}
