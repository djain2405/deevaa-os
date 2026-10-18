import {logEvent} from '../log';
import {enqueueAgentRun, finishAgentRun} from '../runtime/store';
import {getSettings} from '../settings';
import {acquireLock, audit, claimRun, finishRun, getOrCreateUser, getRunByKey, releaseLock, type RunRow} from '../store';
import {agentLocalDate, isAgentDue, isCatchUpHour, listAgents, type AgentDef} from './registry';

const LOCK_TTL_MS = 2 * 60 * 1000;

export type JobOutcome = 'created' | 'duplicate' | 'locked' | 'failed' | 'skipped';

export type JobResult = {
  agentId: string;
  outcome: JobOutcome;
  date: string;
  run: RunRow | null;
};

export function agentIdempotencyKey(agentId: string, userId: string, localDate: string) {
  return `agent:${agentId}:${userId}:${localDate}`;
}

export async function runAgent(
  agent: AgentDef,
  userId: string,
  localDate: string,
  trigger: RunRow['trigger'],
  idempotencyKey: string,
  now = new Date(),
  dryRun = false
): Promise<JobResult> {
  const claim = await claimRun({userId, localDate, trigger, idempotencyKey});
  if (claim.outcome === 'duplicate') {
    await audit(userId, 'agent.run', 'duplicate', {agentId: agent.id, date: localDate});
    return {agentId: agent.id, outcome: 'duplicate', date: localDate, run: claim.run};
  }

  const lockKey = `agent:${agent.id}:${userId}:${localDate}`;
  const owner = await acquireLock(lockKey, LOCK_TTL_MS);
  if (!owner) {
    const run = await finishRun(claim.run.id, {status: 'failed', errorCode: 'locked'});
    return {agentId: agent.id, outcome: 'locked', date: localDate, run};
  }

  try {
    const result = await agent.handler({userId, localDate, runId: claim.run.id, now, dryRun});
    const mirrored = await enqueueAgentRun({
      userId,
      agentId: agent.id,
      goal: agent.title,
      trigger,
      idempotencyKey: `runtime:${idempotencyKey}`
    });
    if (mirrored.outcome === 'queued' && mirrored.run) {
      await finishAgentRun(mirrored.run.id, {status: 'completed', verifier: {legacyRunId: claim.run.id, dryRun}});
    }
    const run = await finishRun(claim.run.id, {status: 'succeeded', briefingId: result.briefingId});
    await audit(userId, 'agent.run', 'ok', {agentId: agent.id, date: localDate});
    logEvent('info', 'agent.run', {agentId: agent.id, outcome: 'created'});
    return {agentId: agent.id, outcome: 'created', date: localDate, run};
  } catch (e) {
    logEvent('error', 'agent.run', {agentId: agent.id, kind: e instanceof Error ? e.name : 'unknown'});
    const run = await finishRun(claim.run.id, {status: 'failed', errorCode: 'internal'});
    await audit(userId, 'agent.run', 'error', {agentId: agent.id, date: localDate, code: 'internal'});
    return {agentId: agent.id, outcome: 'failed', date: localDate, run};
  } finally {
    await releaseLock(lockKey, owner);
  }
}

export async function dispatchDueAgents(now = new Date(), opts: {force?: boolean; agentId?: string; dryRun?: boolean} = {}): Promise<JobResult[]> {
  const email = process.env.ALLOWED_EMAIL;
  if (!email) throw new Error('not_configured');
  const user = await getOrCreateUser(email);
  const settings = await getSettings(user.id);
  const out: JobResult[] = [];
  for (const agent of listAgents()) {
    if (opts.agentId && agent.id !== opts.agentId) continue;
    const date = agentLocalDate(agent, now);
    if (settings.pauseAll || settings.maintenanceMode) {
      out.push({agentId: agent.id, outcome: 'skipped', date, run: null});
      continue;
    }
    const key = agentIdempotencyKey(agent.id, user.id, date) + (opts.dryRun ? ':dry' : '');
    const onHour = isAgentDue(agent, now);
    let catchUp = false;
    if (!opts.force && !onHour) {
      if (isCatchUpHour(agent, now)) {
        const prior = await getRunByKey(key);
        if (prior?.status === 'succeeded') {
          out.push({agentId: agent.id, outcome: 'skipped', date, run: null});
          continue;
        }
        catchUp = true;
      } else {
        out.push({agentId: agent.id, outcome: 'skipped', date, run: null});
        continue;
      }
    }
    logEvent('info', 'jobs.dispatch', {agentId: agent.id, due: catchUp ? 'catch_up' : 'on_hour'});
    out.push(await runAgent(agent, user.id, date, 'agent', key, now, opts.dryRun));
  }
  return out;
}
