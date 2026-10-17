import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const session = vi.hoisted(() => ({user: null as null | {id: string; email: string}}));
vi.mock('@/lib/session', () => ({getSessionUser: vi.fn(async () => session.user)}));

import {GET as gmailCallback} from '@/app/api/google/gmail/callback/route';
import {POST as gmailConnect} from '@/app/api/google/gmail/connect/route';
import {POST as gmailJob} from '@/app/api/jobs/gmail/route';
import {POST as gmailItem} from '@/app/api/jobs/gmail/item/route';
import {applyEmailDigest, mergeEmailDigest} from '@/lib/briefing-merge';
import {hideEmailItem, saveEmailItemToNotion} from '@/lib/email-items';
import {decryptSecret, encryptSecret, signState} from '@/lib/crypto';
import {extractDigest, extractWithRules, groundModelOutput} from '@/lib/gmail-extract';
import {
  completeGmailAuthorization,
  fetchGmailMessages,
  GMAIL_PROVIDER,
  GMAIL_QUERY,
  GMAIL_SCOPE,
  gmailPermalink,
  scopeIsGmailReadOnly
} from '@/lib/google-gmail';
import {getBriefing, getCredential, getOrCreateUser, saveCredential, upsertBriefing} from '@/lib/store';
import {localDate} from '@/lib/time';
import {BRIEFING_VERSION, type BriefingSnapshot, type Task} from '@/lib/types';
import {freshDb, json, mockFetch} from './helpers';

const fast = {retryDelayMs: 0};
const now = new Date('2026-10-14T14:00:00Z');
let userId: string;

beforeEach(async () => {
  await freshDb();
  userId = (await getOrCreateUser('owner@example.com')).id;
  session.user = {id: userId, email: 'owner@example.com'};
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function msg(id: string, fields: {subject: string; from?: string; snippet?: string; excerpt?: string; labelIds?: string[]}) {
  return {
    id,
    threadId: id,
    subject: fields.subject,
    from: fields.from ?? 'Ada <ada@example.com>',
    snippet: fields.snippet ?? '',
    excerpt: fields.excerpt ?? '',
    labelIds: fields.labelIds ?? ['INBOX'],
    internalDate: Date.parse('2026-10-14T13:00:00Z')
  };
}

function gmailRaw(id: string, fields: {subject: string; from?: string; snippet?: string; body?: string; labelIds?: string[]}) {
  return {
    id,
    threadId: id,
    snippet: fields.snippet ?? fields.body ?? '',
    labelIds: fields.labelIds ?? ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        {name: 'Subject', value: fields.subject},
        {name: 'From', value: fields.from ?? 'Ada <ada@example.com>'}
      ],
      body: fields.body && !(fields.snippet ?? '') ? {data: Buffer.from(fields.body).toString('base64url')} : {}
    }
  };
}

async function storeGmailToken(token = 'gmail-refresh-plaintext') {
  await saveCredential({
    userId,
    provider: GMAIL_PROVIDER,
    encryptedRefreshToken: encryptSecret(token, `${userId}:${GMAIL_PROVIDER}`),
    scope: GMAIL_SCOPE,
    calendarIds: []
  });
}

describe('Gmail scope', () => {
  it('accepts only gmail.readonly and rejects send, modify, and compose', () => {
    expect(scopeIsGmailReadOnly(GMAIL_SCOPE)).toBe(true);
    expect(scopeIsGmailReadOnly(`${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.modify`)).toBe(false);
    expect(scopeIsGmailReadOnly(`${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.send`)).toBe(false);
    expect(scopeIsGmailReadOnly('https://www.googleapis.com/auth/gmail.compose')).toBe(false);
    expect(scopeIsGmailReadOnly('https://mail.google.com/')).toBe(false);
  });
});

describe('grounded extraction', () => {
  it('extracts dated actions and skips promotions and social', () => {
    const out = extractWithRules(
      [
        msg('invoice', {subject: 'Invoice due tomorrow', snippet: 'Please pay the invoice due tomorrow.'}),
        msg('promo', {subject: 'Sale expires tonight', snippet: 'This offer expires tonight.', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS']}),
        msg('social', {subject: 'RSVP due today', snippet: 'RSVP due today for the event.', labelIds: ['CATEGORY_SOCIAL']}),
        msg('visa', {subject: 'Visa interview confirmation', snippet: 'Your visa interview is booked downtown.'})
      ],
      now
    );
    expect(out.actions.map((a) => a.title)).toEqual(['Invoice due tomorrow']);
    expect(out.actions[0].due).toBe('2026-10-15');
    expect(out.actions[0].evidence.toLowerCase()).toContain('due');
    expect(out.summaries.map((s) => s.subject)).toEqual(['Visa interview confirmation']);
  });

  it('drops receipts and shipping unless a remaining deadline is quoted', () => {
    const out = extractWithRules(
      [
        msg('receipt', {subject: 'Your receipt from Store', snippet: 'Thank you for your payment of $42 today.'}),
        msg('ship', {subject: 'Your order has shipped', snippet: 'Tracking number 1Z999. Out for delivery tomorrow.'}),
        msg('thanks', {subject: 'Thanks for your payment', snippet: 'We received your payment. This is a receipt.'}),
        msg('bill', {subject: 'Invoice due Friday', snippet: 'This invoice is due Friday. Please pay.'}),
        msg('renew', {subject: 'Receipt — payment due October 20', snippet: 'Your receipt. Payment due October 20 to keep the subscription.'})
      ],
      now
    );
    expect(out.actions.map((a) => a.title)).toEqual(['Invoice due Friday', 'Receipt — payment due October 20']);
    expect(out.actions[0].due).toBe('2026-10-16');
    expect(out.actions[1].due).toBe('2026-10-20');
    expect(out.summaries).toEqual([]);
  });

  it('drops schema-invalid model output and ungrounded or invented deadlines', () => {
    const messages = [msg('m1', {subject: 'Please RSVP by Friday', snippet: 'Please RSVP by Friday if you can attend.'})];
    expect(groundModelOutput({nope: true}, messages, now).dropped).toBe(-1);
    const invented = groundModelOutput(
      {
        actions: [{title: 'RSVP', due: '2099-01-01', why: 'soon', evidence: 'RSVP by Friday', messageId: 'm1'}],
        summaries: [{why: 'made up', evidence: 'words that never appear', messageId: 'm1'}]
      },
      messages,
      now
    );
    expect(invented.actions).toHaveLength(1);
    expect(invented.actions[0].due).toBe('2026-10-16');
    expect(invented.summaries).toHaveLength(0);
    expect(invented.dropped).toBe(1);
  });

  it('ignores optional AI when the model payload is invalid', async () => {
    const {impl} = mockFetch([['api.openai.com', () => json({choices: [{message: {content: '{"actions":"nope"}'}}]})]]);
    const out = await extractDigest([msg('m1', {subject: 'Invoice due tomorrow', snippet: 'Invoice due tomorrow'})], now, {
      apiKey: 'sk-test',
      fetchImpl: impl,
      ...fast
    });
    expect(out.actions[0].title).toMatch(/Invoice/);
    expect(out.warnings.join(' ')).toMatch(/format|ignored/i);
  });
});

describe('digest merge', () => {
  it('does not wipe top outcomes when merging an email digest', async () => {
    const snapshot = {
      version: BRIEFING_VERSION,
      date: '2026-10-14',
      timezone: 'America/Los_Angeles',
      generatedAt: '2026-10-14T05:00:00.000Z',
      status: 'complete',
      summary: 'Keep this.',
      sources: {
        notion: {state: 'connected', message: 'ok', lastSyncedAt: null, count: 1, warnings: []},
        calendar: {state: 'connected', message: 'ok', lastSyncedAt: null, count: 0, warnings: []}
      },
      warnings: [],
      topOutcomes: [{task: {id: 't1', title: 'Ship PR', status: 'Ready', priority: 'High', due: null, duration: 30, url: 'https://notion.so/t1', sourceLink: null, source: 'notion'}, reasons: ['due'], nextAction: 'Open PR', lane: 'Important'}],
      blocks: [],
      tasks: [],
      events: [],
      capacity: {known: true, freeMinutes: 60, busyMinutes: 0, freeWindows: []},
      ai: {status: 'disabled', detail: null}
    } as BriefingSnapshot;
    const merged = applyEmailDigest(snapshot, {
      status: 'complete',
      generatedAt: '2026-10-14T14:05:00.000Z',
      actions: [{title: 'Pay invoice', due: '2026-10-15', why: 'due', permalink: 'https://mail.google.com/mail/u/0/#inbox/x', evidence: 'due tomorrow'}],
      summaries: [],
      warnings: []
    });
    expect(merged.topOutcomes[0].task.title).toBe('Ship PR');
    expect(merged.summary).toBe('Keep this.');
    expect(merged.emailDigest?.actions).toHaveLength(1);
    await upsertBriefing({
      userId,
      localDate: '2026-10-14',
      version: BRIEFING_VERSION,
      status: snapshot.status,
      snapshot,
      runId: '00000000-0000-4000-8000-000000000001',
      generatedAt: new Date(snapshot.generatedAt)
    });
    await mergeEmailDigest(userId, '2026-10-14', merged.emailDigest!, '00000000-0000-4000-8000-000000000002');
    const stored = (await getBriefing(userId, '2026-10-14', BRIEFING_VERSION))!.snapshot as BriefingSnapshot;
    expect(stored.topOutcomes[0].task.title).toBe('Ship PR');
    expect(stored.emailDigest?.actions[0].title).toBe('Pay invoice');
  });
});

describe('Gmail OAuth and reads', () => {
  it('connect redirects with only gmail.readonly', async () => {
    const res = await gmailConnect(new Request('http://localhost:3000/api/google/gmail/connect', {method: 'POST', headers: {origin: 'http://localhost:3000'}}));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.get('scope')).toBe(GMAIL_SCOPE);
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/google/gmail/callback');
    expect(loc.searchParams.get('include_granted_scopes')).toBe('false');
  });

  it('stores an encrypted refresh token and refuses broader grants', async () => {
    const {impl} = mockFetch([['oauth2.googleapis.com/token', () => json({access_token: 'acc', refresh_token: 'gmail-rt-secret', scope: GMAIL_SCOPE})]]);
    vi.stubGlobal('fetch', impl);
    const state = signState({uid: userId, nonce: 'n1', exp: Date.now() + 60000});
    const res = await gmailCallback(
      new Request(`http://localhost:3000/api/google/gmail/callback?code=c&state=${state}`, {headers: {cookie: 'deevaa_gmail_nonce=n1'}})
    );
    expect(res.headers.get('location')).toContain('gmail=connected');
    expect(res.headers.get('location')).toContain('http://localhost:3000/');
    const cred = (await getCredential(userId, GMAIL_PROVIDER))!;
    expect(cred.encryptedRefreshToken).not.toContain('gmail-rt-secret');
    expect(decryptSecret(cred.encryptedRefreshToken, `${userId}:${GMAIL_PROVIDER}`)).toBe('gmail-rt-secret');
    await expect(
      completeGmailAuthorization(userId, 'code', {
        fetchImpl: mockFetch([['oauth2.googleapis.com/token', () => json({access_token: 'a', refresh_token: 'r', scope: 'https://www.googleapis.com/auth/gmail.send'})]]).impl,
        ...fast
      })
    ).rejects.toMatchObject({kind: 'scope'});
  });

  it('redirects to APP_URL after connect even when the request origin is Railway localhost:8080', async () => {
    vi.stubEnv('APP_URL', 'https://deevaa-os-production.up.railway.app');
    const {impl} = mockFetch([['oauth2.googleapis.com/token', () => json({access_token: 'acc', refresh_token: 'gmail-rt-secret', scope: GMAIL_SCOPE})]]);
    vi.stubGlobal('fetch', impl);
    const state = signState({uid: userId, nonce: 'n8080', exp: Date.now() + 60000});
    const res = await gmailCallback(
      new Request(`https://localhost:8080/api/google/gmail/callback?code=c&state=${state}`, {headers: {cookie: 'deevaa_gmail_nonce=n8080'}})
    );
    expect(res.headers.get('location')).toBe('https://deevaa-os-production.up.railway.app/?gmail=connected');
  });

  it('reports not_connected when Gmail is disconnected and does not invent mail', async () => {
    const {messages, health} = await fetchGmailMessages(userId);
    expect(health.state).toBe('not_connected');
    expect(messages).toEqual([]);
  });

  it('lists primary inbox mail, skips promotions, and never writes', async () => {
    await storeGmailToken();
    const {impl, calls} = mockFetch([
      ['oauth2.googleapis.com/token', () => json({access_token: 'access-1', expires_in: 3600})],
      ['messages/pay', () => json(gmailRaw('pay', {subject: 'Invoice due tomorrow', snippet: 'Please pay the invoice due tomorrow.'}))],
      ['messages/promo', () => json(gmailRaw('promo', {subject: 'Sale', snippet: 'expires tonight', labelIds: ['CATEGORY_PROMOTIONS']}))],
      ['users/me/messages?', () => json({messages: [{id: 'pay'}, {id: 'promo'}]})]
    ]);
    const {messages, health} = await fetchGmailMessages(userId, {fetchImpl: impl, ...fast});
    expect(health.state).toBe('connected');
    expect(messages.map((m) => m.id)).toEqual(['pay']);
    const list = calls.find((c) => c.url.includes('users/me/messages?'))!;
    expect(new URL(list.url).searchParams.get('q')).toBe(GMAIL_QUERY);
    expect(calls.every((c) => c.init.method !== 'PATCH' && c.init.method !== 'PUT' && c.init.method !== 'DELETE')).toBe(true);
  });

  it('marks a revoked refresh token and stops calling Google', async () => {
    await storeGmailToken();
    const {impl, calls} = mockFetch([
      ['oauth2.googleapis.com/token', () => json({error: 'invalid_grant', error_description: 'Token has been expired or revoked.'}, 400)]
    ]);
    const first = await fetchGmailMessages(userId, {fetchImpl: impl, ...fast});
    expect(first.health.state).toBe('error');
    expect(first.health.message).toMatch(/Reconnect/);
    expect(first.messages).toEqual([]);
    expect((await getCredential(userId, GMAIL_PROVIDER))!.status).toBe('revoked');
    const before = calls.length;
    const second = await fetchGmailMessages(userId, {fetchImpl: impl, ...fast});
    expect(second.health.state).toBe('error');
    expect(calls.length).toBe(before);
  });
});

describe('manual Gmail digest', () => {
  it('writes an unavailable digest when Gmail is not connected', async () => {
    const res = await gmailJob(
      new Request('http://localhost:3000/api/jobs/gmail', {
        method: 'POST',
        headers: {origin: 'http://localhost:3000', 'idempotency-key': 'manual-gmail-1'}
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('created');
    expect(body.briefing.emailDigest.status).toBe('unavailable');
    expect(body.briefing.emailDigest.actions).toEqual([]);
  });
});

describe('email item decisions', () => {
  const permalink = gmailPermalink('thread-invoice');

  async function seedDigest() {
    const date = localDate();
    await upsertBriefing({
      userId,
      localDate: date,
      version: BRIEFING_VERSION,
      status: 'partial',
      runId: '00000000-0000-4000-8000-000000000010',
      generatedAt: new Date(),
      snapshot: {
        version: BRIEFING_VERSION,
        date,
        timezone: 'America/Los_Angeles',
        generatedAt: new Date().toISOString(),
        status: 'partial',
        summary: 'digest',
        sources: {
          notion: {state: 'not_connected', message: '', lastSyncedAt: null, count: 0, warnings: []},
          calendar: {state: 'not_connected', message: '', lastSyncedAt: null, count: 0, warnings: []}
        },
        warnings: [],
        topOutcomes: [],
        blocks: [],
        tasks: [],
        events: [],
        capacity: {known: false, freeMinutes: null, busyMinutes: null, freeWindows: []},
        ai: {status: 'disabled', detail: null},
        emailDigest: {
          status: 'complete',
          generatedAt: new Date().toISOString(),
          actions: [
            {title: 'Invoice due Friday', due: '2026-10-16', why: 'due', permalink, evidence: 'due Friday'}
          ],
          summaries: [],
          warnings: []
        }
      }
    });
  }

  it('hides an item from today’s digest', async () => {
    await seedDigest();
    const hidden = await hideEmailItem(userId, permalink);
    expect(hidden.kind).toBe('hidden');
    const res = await gmailItem(
      new Request('http://localhost:3000/api/jobs/gmail/item', {
        method: 'POST',
        headers: {origin: 'http://localhost:3000', 'content-type': 'application/json'},
        body: JSON.stringify({permalink, action: 'hide'})
      })
    );
    expect(res.status).toBe(200);
  });

  it('creates a Notion task with the quoted due date when saving', async () => {
    await seedDigest();
    const task = {
      id: 'notion-1',
      title: 'Invoice due Friday',
      status: 'Ready',
      rawStatus: 'Ready',
      priority: 'None',
      due: '2026-10-16',
      duration: null,
      context: 'Anywhere',
      energy: 'Low',
      blocker: null,
      blockedBy: [],
      externalKey: 'deevaa:gmail:thread-invoice',
      project: null,
      nextAction: 'due',
      url: 'https://www.notion.so/invoice',
      sourceLink: permalink,
      source: 'notion',
      lastEditedAt: new Date().toISOString()
    } as Task;
    const result = await saveEmailItemToNotion(userId, permalink, {
      hasPermission: async () => true,
      loadWriteTarget: async () => ({token: 't', dataSourceId: 'ds', titleProperty: 'Name', props: {}}),
      findByExternalKey: async () => null,
      createTask: async (_target, fields) => {
        expect(fields.title).toBe('Invoice due Friday');
        expect(fields.due).toBe('2026-10-16');
        expect(fields.sourceLink).toBe(permalink);
        expect(fields.externalKey).toBe('deevaa:gmail:thread-invoice');
        return {task, skipped: []};
      }
    });
    expect(result.created).toBe(true);
    expect(result.item.kind).toBe('saved');
    expect(result.item.pageUrl).toBe('https://www.notion.so/invoice');
  });

  it('refuses to save when Notion writes are off', async () => {
    await seedDigest();
    await expect(saveEmailItemToNotion(userId, permalink, {hasPermission: async () => false})).rejects.toMatchObject({code: 'writes_off'});
  });
});
