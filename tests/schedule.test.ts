import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {GET as cron, POST as cronPost} from '@/app/api/cron/route';
import {acquireLock, countBriefings, getOrCreateUser, listRuns, releaseLock} from '@/lib/store';
import {tomorrowLocal} from '@/lib/time';
import {freshDb} from './helpers';

const SECRET = 'scheduler-secret-0123456789abcdef';
const call = (method: 'GET' | 'POST' = 'GET') =>
  (method === 'GET' ? cron : cronPost)(new Request('https://deevaa.example/api/cron', {method, headers: {authorization: `Bearer ${SECRET}`}}));

let userId: string;

beforeEach(async () => {
  await freshDb();
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('NOTION_TOKEN', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.useFakeTimers({toFake: ['Date'], now: new Date('2026-10-14T05:00:00Z')});
  userId = (await getOrCreateUser('owner@example.com')).id;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('scheduled briefing', () => {
  it('targets tomorrow in America/Los_Angeles across both DST transitions', () => {
    expect(tomorrowLocal(new Date('2026-10-14T05:00:00Z'))).toBe('2026-10-14');
    expect(tomorrowLocal(new Date('2026-03-09T05:00:00Z'))).toBe('2026-03-09');
    expect(tomorrowLocal(new Date('2026-11-02T05:00:00Z'))).toBe('2026-11-02');
  });

  it('saves one briefing and returns run metadata only', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({outcome: 'created', date: '2026-10-14', run: {trigger: 'cron', status: 'succeeded'}});
    expect(body.briefing).toBeUndefined();
    expect(await countBriefings(userId, '2026-10-14')).toBe(1);
  });

  it('collapses duplicate and concurrent triggers into one run and one briefing', async () => {
    const [a, b] = await Promise.all([call('GET'), call('POST')]);
    const outcomes = [(await a.json()).outcome, (await b.json()).outcome].sort();
    expect(outcomes).toEqual(['created', 'duplicate']);
    const late = await (await call()).json();
    expect(late.outcome).toBe('duplicate');
    expect(await countBriefings(userId, '2026-10-14')).toBe(1);
    const runs = await listRuns(userId, '2026-10-14');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('succeeded');
  });

  it('reports lock contention as a retryable failure and succeeds on retry', async () => {
    const owner = (await acquireLock(`briefing:${userId}:2026-10-14`, 60000))!;
    const blocked = await call();
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).run).toMatchObject({status: 'failed', errorCode: 'locked'});
    await releaseLock(`briefing:${userId}:2026-10-14`, owner);
    const retry = await call();
    expect(retry.status).toBe(200);
    expect((await retry.json()).run).toMatchObject({status: 'succeeded', attempts: 2});
    expect(await listRuns(userId, '2026-10-14')).toHaveLength(1);
  });

  it('runs again for the next night', async () => {
    await call();
    vi.setSystemTime(new Date('2026-10-15T05:00:00Z'));
    const next = await (await call()).json();
    expect(next).toMatchObject({outcome: 'created', date: '2026-10-15'});
  });
});
