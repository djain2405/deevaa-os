import {and, desc, eq} from 'drizzle-orm';
import {getDb} from '../db/client';
import {agentDefinitions, agentRuns, approvalRequests, handoffs, toolInvocations} from '../db/schema';
import {payloadHash, type ToolDecision} from './policy';

export const AGENT_CATALOG = [
  {id: 'gmail.morning', title: 'Morning Gmail digest', mission: 'Read overnight mail and prepare a briefing. Never send.', scopes: ['gmail.read', 'draft.create'], memoryPartition: 'work', outputContract: 'EmailDigest', dailyTokenBudget: 20000},
  {id: 'chief.of.staff', title: 'Chief of Staff', mission: 'Prioritize the day from confirmed sources.', scopes: ['notion.read', 'calendar.read', 'gmail.read'], memoryPartition: 'work', outputContract: 'DailyBrief', dailyTokenBudget: 12000},
  {id: 'project.manager', title: 'Project Manager', mission: 'Keep project status, blockers, and next actions current.', scopes: ['notion.read', 'notion.task.propose'], memoryPartition: 'work', outputContract: 'ProjectSweep', dailyTokenBudget: 8000},
  {id: 'open.source', title: 'Open source', mission: 'Prepare a tested contribution. Opening a PR requires approval. Merging is denied.', scopes: ['github.read', 'draft.create'], memoryPartition: 'work', outputContract: 'ContributionCandidate', dailyTokenBudget: 12000},
  {id: 'gde.research', title: 'Android GDE / research', mission: 'Track CFPs and draft content with citations.', scopes: ['web.read', 'draft.create'], memoryPartition: 'work', outputContract: 'OpportunityBrief', dailyTokenBudget: 8000},
  {id: 'consultancy', title: 'Consultancy', mission: 'Maintain a service catalog and drafts. Never contact a prospect.', scopes: ['draft.create'], memoryPartition: 'work', outputContract: 'PipelineDraft', dailyTokenBudget: 8000},
  {id: 'eb1a', title: 'EB-1A evidence', mission: 'Organize source-backed evidence. No legal conclusions.', scopes: ['notion.read', 'draft.create'], memoryPartition: 'private', outputContract: 'EvidencePacket', dailyTokenBudget: 8000},
  {id: 'life.ops', title: 'Life operations', mission: 'Prepare personal checklists without sharing them with work agents.', scopes: ['notion.read', 'draft.create'], memoryPartition: 'private', outputContract: 'LifeChecklist', dailyTokenBudget: 4000},
  {id: 'memory', title: 'Memory', mission: 'Store and retrieve user-controlled notes with partition boundaries.', scopes: ['memory.read'], memoryPartition: 'reflection', outputContract: 'MemoryNote', dailyTokenBudget: 2000}
] as const;

export async function ensureAgentDefinitions() {
  const db = await getDb();
  for (const agent of AGENT_CATALOG) {
    await db.insert(agentDefinitions).values({...agent, scopes: [...agent.scopes]}).onConflictDoNothing({target: agentDefinitions.id});
  }
  return db.select().from(agentDefinitions);
}

export async function enqueueAgentRun(input: {
  userId: string;
  agentId: string;
  goal: string;
  trigger: string;
  idempotencyKey: string;
  parentRunId?: string | null;
}) {
  const db = await getDb();
  await ensureAgentDefinitions();
  const inserted = await db
    .insert(agentRuns)
    .values({
      userId: input.userId,
      agentId: input.agentId,
      goal: input.goal,
      trigger: input.trigger,
      status: 'queued',
      idempotencyKey: input.idempotencyKey,
      parentRunId: input.parentRunId ?? null
    })
    .onConflictDoNothing({target: agentRuns.idempotencyKey})
    .returning();
  if (inserted[0]) return {outcome: 'queued' as const, run: inserted[0]};
  const [existing] = await db.select().from(agentRuns).where(eq(agentRuns.idempotencyKey, input.idempotencyKey));
  return {outcome: 'duplicate' as const, run: existing};
}

export async function claimQueued(userId: string, limit: number) {
  const db = await getDb();
  const queued = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.status, 'queued')))
    .orderBy(agentRuns.createdAt)
    .limit(limit);
  const claimed = [];
  for (const run of queued) {
    const [row] = await db
      .update(agentRuns)
      .set({status: 'running', startedAt: new Date()})
      .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, 'queued')))
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}

export async function checkpointRun(runId: string, checkpoint: Record<string, unknown>, status?: (typeof agentRuns.$inferSelect)['status']) {
  const db = await getDb();
  const [row] = await db
    .update(agentRuns)
    .set({checkpoint, ...(status ? {status} : {})})
    .where(eq(agentRuns.id, runId))
    .returning();
  return row;
}

export async function finishAgentRun(runId: string, result: {status: 'completed' | 'failed' | 'blocked' | 'canceled'; error?: string; artifacts?: unknown[]; verifier?: Record<string, unknown>; costTokens?: number}) {
  const db = await getDb();
  const [row] = await db
    .update(agentRuns)
    .set({
      status: result.status,
      error: result.error ?? null,
      artifacts: result.artifacts ?? [],
      verifierResult: result.verifier ?? null,
      costTokens: result.costTokens ?? 0,
      finishedAt: new Date()
    })
    .where(eq(agentRuns.id, runId))
    .returning();
  return row;
}

export async function recordTool(input: {runId: string | null; userId: string; tool: string; decision: ToolDecision; outputRef?: string}) {
  const db = await getDb();
  const [row] = await db
    .insert(toolInvocations)
    .values({
      runId: input.runId,
      userId: input.userId,
      tool: input.tool,
      scope: input.decision.decision,
      inputHash: payloadHash({tool: input.tool}),
      status: input.decision.decision === 'allow' ? 'allowed' : input.decision.decision === 'approval' ? 'approval' : 'denied',
      outputRef: input.outputRef ?? null
    })
    .returning();
  return row;
}

export async function createApproval(input: {userId: string; runId?: string | null; action: string; risk: 'low' | 'medium' | 'high' | 'denied'; payload: unknown; evidence?: string; ttlMs?: number}) {
  const db = await getDb();
  const [row] = await db
    .insert(approvalRequests)
    .values({
      userId: input.userId,
      runId: input.runId ?? null,
      action: input.action,
      risk: input.risk,
      payload: input.payload as Record<string, unknown>,
      payloadHash: payloadHash(input.payload),
      evidence: input.evidence ?? null,
      status: 'pending',
      expiresAt: new Date(Date.now() + (input.ttlMs ?? 24 * 60 * 60 * 1000))
    })
    .returning();
  return row;
}

export async function listApprovals(userId: string) {
  const db = await getDb();
  return db.select().from(approvalRequests).where(eq(approvalRequests.userId, userId)).orderBy(desc(approvalRequests.createdAt)).limit(50);
}

export async function getApproval(userId: string, id: string) {
  const db = await getDb();
  const [row] = await db.select().from(approvalRequests).where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));
  return row ?? null;
}

export async function listAgentRuns(userId: string) {
  const db = await getDb();
  return db.select().from(agentRuns).where(eq(agentRuns.userId, userId)).orderBy(desc(agentRuns.createdAt)).limit(40);
}

export async function getAgentRun(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
  return row ?? null;
}

export async function createHandoff(input: {userId: string; fromRunId: string | null; toAgentId: string; payload: unknown}) {
  const db = await getDb();
  const [row] = await db
    .insert(handoffs)
    .values({userId: input.userId, fromRunId: input.fromRunId, toAgentId: input.toAgentId, payload: input.payload as Record<string, unknown>, status: 'queued'})
    .returning();
  return row;
}

export async function listHandoffs(userId: string) {
  const db = await getDb();
  return db.select().from(handoffs).where(eq(handoffs.userId, userId)).orderBy(desc(handoffs.createdAt));
}
