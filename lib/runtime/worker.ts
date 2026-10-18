import {and, eq} from 'drizzle-orm';
import {getDb} from '../db/client';
import {agentRuns, approvalRequests} from '../db/schema';
import {getSettings} from '../settings';
import {decideTool, payloadHash} from './policy';
import {claimQueued, finishAgentRun, getAgentRun, getApproval, recordTool} from './store';

/** Claims queued runs and finishes them with the supplied handler. Pause-all leaves them queued. */
export async function drainQueue(userId: string, limit: number, handler: (run: {id: string; agentId: string; checkpoint: Record<string, unknown> | null}) => Promise<{artifacts?: unknown[]; verifier?: Record<string, unknown>}>) {
  const settings = await getSettings(userId);
  if (settings.pauseAll) return {outcome: 'paused' as const, runs: []};
  const claimed = await claimQueued(userId, limit);
  const runs = [];
  for (const run of claimed) {
    const result = await handler({id: run.id, agentId: run.agentId, checkpoint: run.checkpoint});
    runs.push(await finishAgentRun(run.id, {status: 'completed', artifacts: result.artifacts, verifier: result.verifier}));
  }
  return {outcome: 'drained' as const, runs};
}

/**
 * Moves a run that is waiting on approval forward exactly once.
 * Gmail send is recorded as not sent. A second call finds the run already completed.
 */
export async function resumeAfterApproval(userId: string, runId: string) {
  const existing = await getAgentRun(runId);
  if (!existing || existing.userId !== userId) return {outcome: 'missing' as const};
  if (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'canceled') return {outcome: 'duplicate' as const};
  if (existing.status !== 'awaiting_approval') return {outcome: 'not_waiting' as const};

  const db = await getDb();
  const [approval] = await db.select().from(approvalRequests).where(eq(approvalRequests.runId, runId)).orderBy(approvalRequests.createdAt);
  if (!approval || approval.status !== 'approved') return {outcome: 'still_waiting' as const};
  if (approval.expiresAt.getTime() < Date.now()) {
    await db.update(approvalRequests).set({status: 'expired'}).where(eq(approvalRequests.id, approval.id));
    return {outcome: 'expired' as const};
  }
  if (approval.payloadHash !== payloadHash(approval.payload)) return {outcome: 'hash_mismatch' as const};

  const [claimed] = await db
    .update(agentRuns)
    .set({status: 'running', checkpoint: {...(existing.checkpoint ?? {}), resumed: true}})
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'awaiting_approval')))
    .returning();
  if (!claimed) return {outcome: 'duplicate' as const};

  const decision = decideTool(approval.action);
  await recordTool({runId, userId, tool: approval.action, decision});
  const external = approval.action === 'gmail.send' || approval.action === 'outreach.send' || approval.action === 'github.pr.merge' || decision.decision === 'deny';
  const verifier = external
    ? {executed: false, sent: false, merged: false, reason: 'Approved actions of this type are not performed automatically.'}
    : {executed: true, sent: false};
  await db.update(approvalRequests).set({status: 'executed', executionResult: verifier, decidedAt: approval.decidedAt ?? new Date()}).where(eq(approvalRequests.id, approval.id));
  const run = await finishAgentRun(runId, {status: 'completed', artifacts: [approval.payload], verifier});
  return {outcome: 'completed' as const, run, verifier};
}

export async function decideApproval(userId: string, id: string, status: 'approved' | 'rejected' | 'edited', nextPayload?: unknown) {
  const row = await getApproval(userId, id);
  if (!row) return {outcome: 'missing' as const};
  if (row.status !== 'pending' && row.status !== 'edited') return {outcome: 'duplicate' as const, status: row.status};
  if (row.expiresAt.getTime() < Date.now()) {
    const db = await getDb();
    await db.update(approvalRequests).set({status: 'expired'}).where(eq(approvalRequests.id, id));
    return {outcome: 'expired' as const};
  }
  const db = await getDb();
  if (status === 'edited') {
    if (nextPayload === undefined) return {outcome: 'missing' as const};
    const [updated] = await db
      .update(approvalRequests)
      .set({payload: nextPayload as Record<string, unknown>, payloadHash: payloadHash(nextPayload), status: 'pending'})
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)))
      .returning();
    return {outcome: 'edited' as const, approval: updated};
  }
  const [updated] = await db
    .update(approvalRequests)
    .set({status, decidedAt: new Date()})
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId), eq(approvalRequests.status, 'pending')))
    .returning();
  if (!updated) return {outcome: 'duplicate' as const, status: row.status};
  return {outcome: status, approval: updated};
}

export async function markAwaitingApproval(runId: string) {
  const db = await getDb();
  const [row] = await db.update(agentRuns).set({status: 'awaiting_approval'}).where(eq(agentRuns.id, runId)).returning();
  return row;
}
