import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {GET as jobsGet, POST as jobsPost} from '@/app/api/jobs/route';
import {agentIdempotencyKey, dispatchDueAgents} from '@/lib/agents/dispatch';
import {getAgent, isAgentDue} from '@/lib/agents/registry';
import {encryptSecret} from '@/lib/crypto';
import {GMAIL_PROVIDER, GMAIL_SCOPE} from '@/lib/google-gmail';
import {acquireLock, getBriefing, getOrCreateUser, listRuns, releaseLock, saveCredential} from '@/lib/store';
import {BRIEFING_VERSION, type BriefingSnapshot} from '@/lib/types';
import {freshDb, json, mockFetch} from './helpers';

const SECRET = 'scheduler-secret-0123456789abcdef';
const SEVEN_AM_PT = new Date('2026-10-14T14:00:00Z');
const SIX_AM_PT = new Date('2026-10-14T13:00:00Z');
const NINE_AM_PT = new Date('2026-10-14T16:00:00Z');
const ONE_PM_PT = new Date('2026-10-14T20:00:00Z');

function call(method: 'GET' | 'POST' = 'GET') {
  const req = new Request('https://deevaa.example/api/jobs', {method, headers: {authorization: `Bearer ${SECRET}`}});
  return method === 'GET' ? jobsGet(req) : jobsPost(req);
}

let userId: string;

beforeEach(async () => {
  await freshDb();
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('ALLOWED_EMAIL', 'owner@example.com');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.useFakeTimers({toFake: ['Date'], now: SEVEN_AM_PT});
  userId = (await getOrCreateUser('owner@example.com')).id;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('agent registry', () => {
  it('registers gmail.morning at 7:00 America/Los_Angeles and stays due for the whole hour', () => {
    const agent = getAgent('gmail.morning')!;
    expect(agent.localHour).toBe(7);
    expect(agent.timezone).toBe('America/Los_Angeles');
    expect(isAgentDue(agent, SEVEN_AM_PT)).toBe(true);
    expect(isAgentDue(agent, new Date('2026-10-14T14:45:00Z'))).toBe(true);
    expect(isAgentDue(agent, SIX_AM_PT)).toBe(false);
    expect(isAgentDue(agent, new Date('2026-10-14T15:00:00Z'))).toBe(false);
  });
});

describe('job dispatcher', () => {
  it('skips agents outside their local hour', async () => {
    vi.setSystemTime(SIX_AM_PT);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs).toEqual([expect.objectContaining({agentId: 'gmail.morning', outcome: 'skipped', date: '2026-10-14', run: null})]);
    expect(await listRuns(userId, '2026-10-14')).toHaveLength(0);
  });

  it('catches up until noon when the 7:00 run never succeeded, then skips', async () => {
    vi.setSystemTime(NINE_AM_PT);
    const first = await call();
    expect(first.status).toBe(200);
    expect((await first.json()).jobs[0].outcome).toBe('created');
    expect(await listRuns(userId, '2026-10-14')).toHaveLength(1);

    const again = await call();
    expect((await again.json()).jobs[0].outcome).toBe('skipped');

    vi.setSystemTime(ONE_PM_PT);
    const late = await (await call()).json();
    expect(late.jobs[0].outcome).toBe('skipped');
  });

  it('does not catch up after noon when 7:00 never ran', async () => {
    vi.setSystemTime(ONE_PM_PT);
    const res = await call();
    expect((await res.json()).jobs[0]).toMatchObject({agentId: 'gmail.morning', outcome: 'skipped', run: null});
    expect(await listRuns(userId, '2026-10-14')).toHaveLength(0);
  });

  it('runs once per agent per local date and collapses duplicates', async () => {
    const [a, b] = await Promise.all([call('GET'), call('POST')]);
    const outcomes = [(await a.json()).jobs[0].outcome, (await b.json()).jobs[0].outcome].sort();
    expect(outcomes).toEqual(['created', 'duplicate']);
    const late = await (await call()).json();
    expect(late.jobs[0].outcome).toBe('duplicate');
    const runs = await listRuns(userId, '2026-10-14');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({trigger: 'agent', status: 'succeeded', idempotencyKey: agentIdempotencyKey('gmail.morning', userId, '2026-10-14')});
    const briefing = await getBriefing(userId, '2026-10-14', BRIEFING_VERSION);
    expect((briefing?.snapshot as BriefingSnapshot).emailDigest?.status).toBe('unavailable');
    expect((briefing?.snapshot as BriefingSnapshot).topOutcomes).toEqual([]);
  });

  it('does not collide with a stored plan when merging a digest', async () => {
    const {upsertBriefing} = await import('@/lib/store');
    await upsertBriefing({
      userId,
      localDate: '2026-10-14',
      version: BRIEFING_VERSION,
      status: 'complete',
      runId: '00000000-0000-4000-8000-000000000099',
      generatedAt: new Date('2026-10-14T05:00:00Z'),
      snapshot: {
        version: BRIEFING_VERSION,
        date: '2026-10-14',
        timezone: 'America/Los_Angeles',
        generatedAt: '2026-10-14T05:00:00.000Z',
        status: 'complete',
        summary: 'Plan stands.',
        sources: {
          notion: {state: 'connected', message: 'ok', lastSyncedAt: null, count: 1, warnings: []},
          calendar: {state: 'connected', message: 'ok', lastSyncedAt: null, count: 0, warnings: []}
        },
        warnings: [],
        topOutcomes: [{task: {id: 'keep', title: 'Keep me', status: 'Ready', priority: 'High', due: null, duration: 25, url: 'https://notion.so/keep', sourceLink: null, source: 'notion'}, reasons: ['ready'], nextAction: 'Start', lane: 'Important'}],
        blocks: [],
        tasks: [],
        events: [],
        capacity: {known: true, freeMinutes: 90, busyMinutes: 0, freeWindows: []},
        ai: {status: 'disabled', detail: null}
      }
    });
    await dispatchDueAgents(SEVEN_AM_PT);
    const snapshot = (await getBriefing(userId, '2026-10-14', BRIEFING_VERSION))!.snapshot as BriefingSnapshot;
    expect(snapshot.topOutcomes[0].task.title).toBe('Keep me');
    expect(snapshot.summary).toBe('Plan stands.');
    expect(snapshot.emailDigest).toBeTruthy();
  });

  it('reports lock contention as retryable and succeeds after release', async () => {
    const owner = (await acquireLock(`agent:gmail.morning:${userId}:2026-10-14`, 60000))!;
    const blocked = await call();
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).jobs[0].run).toMatchObject({status: 'failed', errorCode: 'locked'});
    await releaseLock(`agent:gmail.morning:${userId}:2026-10-14`, owner);
    const retry = await call();
    expect(retry.status).toBe(200);
    expect((await retry.json()).jobs[0].run).toMatchObject({status: 'succeeded', attempts: 2});
  });

  it('reads Gmail when connected and does not invent messages on provider failure', async () => {
    await saveCredential({
      userId,
      provider: GMAIL_PROVIDER,
      encryptedRefreshToken: encryptSecret('rt', `${userId}:${GMAIL_PROVIDER}`),
      scope: GMAIL_SCOPE,
      calendarIds: []
    });
    const {impl} = mockFetch([
      ['oauth2.googleapis.com/token', () => json({access_token: 'a'})],
      ['users/me/messages?', () => json({error: {message: 'Backend Error'}}, 503)]
    ]);
    vi.stubGlobal('fetch', impl);
    const result = await dispatchDueAgents(SEVEN_AM_PT);
    expect(result[0].outcome).toBe('created');
    const digest = ((await getBriefing(userId, '2026-10-14', BRIEFING_VERSION))!.snapshot as BriefingSnapshot).emailDigest!;
    expect(digest.actions).toEqual([]);
    expect(digest.summaries).toEqual([]);
    expect(digest.warnings.join(' ')).not.toContain('Backend Error');
    expect(digest.status).toBe('unavailable');
  });
});
