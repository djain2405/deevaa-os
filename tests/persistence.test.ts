import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const session = vi.hoisted(() => ({user: null as null | {id: string; email: string}}));
vi.mock('@/lib/session', () => ({getSessionUser: vi.fn(async () => session.user)}));

import {GET as getBriefing} from '@/app/api/briefing/route';
import {POST as regenerate} from '@/app/api/briefing/regenerate/route';
import {runBriefing, type BriefingDeps} from '@/lib/briefing-service';
import {encryptSecret} from '@/lib/crypto';
import {CALENDAR_SCOPE, PROVIDER} from '@/lib/google-calendar';
import {acquireLock, countBriefings, getBriefing as loadBriefing, getOrCreateUser, listAudit, listRuns, saveCredential} from '@/lib/store';
import {localDate} from '@/lib/time';
import {BRIEFING_VERSION, type BriefingSnapshot} from '@/lib/types';
import {connected, failed, freshDb, json, mockFetch, task} from './helpers';

const DATE = '2026-10-14';
let userId: string;

const deps = (overrides: Partial<BriefingDeps> = {}): BriefingDeps => ({
  fetchTasks: async () => ({tasks: [task({id: 'a', priority: 'High'}), task({id: 'b', duration: 10})], health: connected(2)}),
  fetchEvents: async () => ({events: [], health: connected(0)}),
  enhance: async (b) => b,
  now: () => new Date('2026-10-14T05:00:00Z'),
  ...overrides
});

beforeEach(async () => {
  await freshDb();
  userId = (await getOrCreateUser('owner@example.com')).id;
  session.user = {id: userId, email: 'owner@example.com'};
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('canonical briefing per user, date and version', () => {
  it('replays the same idempotency key without creating another snapshot or run', async () => {
    const first = await runBriefing({userId, date: DATE, trigger: 'manual', idempotencyKey: 'k1'}, deps());
    expect(first.outcome).toBe('created');
    const fetchTasks = vi.fn(deps().fetchTasks);
    const again = await runBriefing({userId, date: DATE, trigger: 'manual', idempotencyKey: 'k1'}, deps({fetchTasks}));
    expect(again.outcome).toBe('duplicate');
    expect(again.run.id).toBe(first.run.id);
    expect(fetchTasks).not.toHaveBeenCalled();
    expect(await countBriefings(userId, DATE)).toBe(1);
    expect(await listRuns(userId, DATE)).toHaveLength(1);
  });

  it('a new key regenerates into the same canonical row and appends run history', async () => {
    const first = await runBriefing({userId, date: DATE, trigger: 'manual', idempotencyKey: 'k1'}, deps());
    const second = await runBriefing({userId, date: DATE, trigger: 'manual', idempotencyKey: 'k2'}, deps());
    expect(second.outcome).toBe('created');
    expect(second.briefing!.id).toBe(first.briefing!.id);
    expect(second.briefing!.runId).toBe(second.run.id);
    expect(await countBriefings(userId, DATE)).toBe(1);
    expect(await listRuns(userId, DATE)).toHaveLength(2);
    const audits = await listAudit(userId);
    expect(audits.filter((a) => a.action === 'briefing.generate' && a.result === 'ok')).toHaveLength(2);
  });

  it('records failures and lets the same key retry', async () => {
    const boom = await runBriefing({userId, date: DATE, trigger: 'cron', idempotencyKey: 'cron-x'}, deps({fetchTasks: async () => { throw new Error('crash'); }}));
    expect(boom.outcome).toBe('failed');
    expect(boom.run).toMatchObject({status: 'failed', errorCode: 'internal'});
    const retry = await runBriefing({userId, date: DATE, trigger: 'cron', idempotencyKey: 'cron-x'}, deps());
    expect(retry.outcome).toBe('created');
    expect(retry.run).toMatchObject({id: boom.run.id, status: 'succeeded', attempts: 2});
  });

  it('does not run while another generation holds the lock', async () => {
    await acquireLock(`briefing:${userId}:${DATE}`, 60000);
    const r = await runBriefing({userId, date: DATE, trigger: 'manual', idempotencyKey: 'k1'}, deps());
    expect(r.outcome).toBe('locked');
    expect(r.run.errorCode).toBe('locked');
    expect(await countBriefings(userId, DATE)).toBe(0);
  });

  it('keeps the last good briefing when a working source starts failing', async () => {
    const good = await runBriefing({userId, date: DATE, trigger: 'manual', idempotencyKey: 'k1'}, deps());
    const bad = await runBriefing({userId, date: DATE, trigger: 'manual', idempotencyKey: 'k2'}, deps({fetchTasks: async () => ({tasks: [], health: failed('Notion rejected the token.')})}));
    expect(bad.outcome).toBe('kept_previous');
    const stored = await loadBriefing(userId, DATE, BRIEFING_VERSION);
    expect(stored!.runId).toBe(good.run.id);
    expect((stored!.snapshot as BriefingSnapshot).tasks).toHaveLength(2);
  });
});

describe('briefing API', () => {
  it('returns null before generation and the stored briefing afterwards with stale and failure warnings', async () => {
    const today = localDate();
    const empty = await (await getBriefing(new Request('http://localhost:3000/api/briefing'))).json();
    expect(empty).toMatchObject({date: today, briefing: null, lastRun: null});
    await runBriefing({userId, date: today, trigger: 'manual', idempotencyKey: 'k1'}, deps({now: () => new Date(Date.now() - 20 * 3600 * 1000)}));
    await runBriefing({userId, date: today, trigger: 'manual', idempotencyKey: 'k2'}, deps({fetchTasks: async () => ({tasks: [], health: failed()})}));
    const res = await getBriefing(new Request('http://localhost:3000/api/briefing'));
    expect(res.headers.get('cache-control')).toContain('private');
    const body = await res.json();
    expect(body.briefing.tasks).toHaveLength(2);
    expect(body.lastRun.status).toBe('failed');
    expect(body.warnings.join(' ')).toMatch(/generated 20 hours ago/);
    expect(body.warnings.join(' ')).toMatch(/previous briefing is still shown/);
  });

  it('requires an idempotency key and dedupes repeated regenerate requests', async () => {
    const headers = {origin: 'http://localhost:3000', 'content-type': 'application/json'};
    const missing = await regenerate(new Request('http://localhost:3000/api/briefing/regenerate', {method: 'POST', headers}));
    expect(missing.status).toBe(400);
    const send = () => regenerate(new Request('http://localhost:3000/api/briefing/regenerate', {method: 'POST', headers: {...headers, 'idempotency-key': 'click-0001'}, body: '{}'}));
    const a = await (await send()).json();
    const b = await (await send()).json();
    expect(a.outcome).toBe('created');
    expect(b.outcome).toBe('duplicate');
    expect(b.run.id).toBe(a.run.id);
    expect(await countBriefings(userId, localDate())).toBe(1);
  });

  it('never exposes tokens, secrets, provider bodies or private event details', async () => {
    vi.stubEnv('NOTION_TOKEN', 'secret_notion_live_token');
    vi.stubEnv('NOTION_DATA_SOURCE_ID', 'ds-1');
    vi.stubEnv('OPENAI_API_KEY', '');
    await saveCredential({userId, provider: PROVIDER, encryptedRefreshToken: encryptSecret('1//refresh-plaintext', `${userId}:${PROVIDER}`), scope: CALENDAR_SCOPE, calendarIds: ['primary']});
    const today = localDate();
    const {impl} = mockFetch([
      ['oauth2.googleapis.com/token', () => json({access_token: 'ya29.access-token-value', expires_in: 3600})],
      ['/calendars/primary/events', () => json({items: [{id: 'e1', summary: 'Therapy', description: 'Discuss private matter', location: '12 Secret St', attendees: [{email: 'doctor@clinic.example', responseStatus: 'accepted'}, {self: true, responseStatus: 'accepted'}], start: {dateTime: `${today}T10:00:00-07:00`}, end: {dateTime: `${today}T11:00:00-07:00`}}]})],
      ['/data_sources/ds-1/query', () => json({results: [{object: 'page', id: 'p1', url: 'https://www.notion.so/p1', last_edited_time: '2026-10-01T00:00:00Z', properties: {Name: {type: 'title', title: [{plain_text: 'Book dentist'}]}, Status: {type: 'select', select: {name: 'Ready'}}, Duration: {type: 'number', number: 10}}}], has_more: false})],
      ['/data_sources/ds-1', () => json({properties: {Name: {id: 't', type: 'title'}, Status: {id: 's', type: 'select'}, Duration: {id: 'd', type: 'number'}}})]
    ]);
    vi.stubGlobal('fetch', impl);
    const gen = await regenerate(new Request('http://localhost:3000/api/briefing/regenerate', {method: 'POST', headers: {origin: 'http://localhost:3000', 'idempotency-key': 'scan-0001'}}));
    const generated = await gen.text();
    const loaded = await (await getBriefing(new Request('http://localhost:3000/api/briefing'))).text();
    for (const text of [generated, loaded]) {
      expect(text).toContain('Book dentist');
      expect(text).toContain('Therapy');
      for (const secret of ['1//refresh-plaintext', 'ya29.access-token-value', 'secret_notion_live_token', 'test-client-secret-value', 'refresh_token', 'access_token', 'client_secret', 'encrypted', 'Discuss private matter', '12 Secret St', 'doctor@clinic.example']) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
