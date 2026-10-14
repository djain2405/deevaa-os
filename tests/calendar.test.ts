import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const session = vi.hoisted(() => ({user: null as null | {id: string; email: string}}));
vi.mock('@/lib/session', () => ({getSessionUser: vi.fn(async () => session.user)}));

import {GET as callback} from '@/app/api/google/callback/route';
import {POST as connect} from '@/app/api/google/connect/route';
import {decryptSecret, encryptSecret, signState} from '@/lib/crypto';
import {CALENDAR_SCOPE, completeAuthorization, fetchCalendarEvents, normalizeEvents, PROVIDER, scopeIsReadOnly} from '@/lib/google-calendar';
import {getCredential, getOrCreateUser, saveCredential} from '@/lib/store';
import {dayBounds} from '@/lib/time';
import {freshDb, json, mockFetch} from './helpers';

const fast = {retryDelayMs: 0};
let userId: string;

beforeEach(async () => {
  await freshDb();
  userId = (await getOrCreateUser('owner@example.com')).id;
  session.user = {id: userId, email: 'owner@example.com'};
});
afterEach(() => vi.unstubAllGlobals());

async function storeToken(token = 'refresh-token-plaintext', calendarIds = ['primary']) {
  await saveCredential({userId, provider: PROVIDER, encryptedRefreshToken: encryptSecret(token, `${userId}:${PROVIDER}`), scope: CALENDAR_SCOPE, calendarIds});
}

describe('America/Los_Angeles day bounds', () => {
  it('handles the spring-forward and fall-back days', () => {
    const spring = dayBounds('2026-03-08');
    expect(spring.end.diff(spring.start, 'hours').hours).toBe(23);
    expect(spring.start.toISO()).toBe('2026-03-08T00:00:00.000-08:00');
    expect(spring.end.toISO()).toBe('2026-03-09T00:00:00.000-07:00');
    const fall = dayBounds('2026-11-01');
    expect(fall.end.diff(fall.start, 'hours').hours).toBe(25);
    expect(dayBounds('2026-12-01').start.offset).toBe(-480);
    expect(dayBounds('2026-10-14').start.offset).toBe(-420);
  });

  it('keeps both 1:30 AM instances on the fall-back day', () => {
    const events = normalizeEvents(
      [
        {id: 'a', start: {dateTime: '2026-11-01T01:30:00-07:00'}, end: {dateTime: '2026-11-01T01:45:00-07:00'}},
        {id: 'b', start: {dateTime: '2026-11-01T01:30:00-08:00'}, end: {dateTime: '2026-11-01T01:45:00-08:00'}}
      ],
      'primary',
      '2026-11-01'
    );
    expect(events.map((e) => e.start)).toEqual(['2026-11-01T01:30:00.000-07:00', '2026-11-01T01:30:00.000-08:00']);
  });
});

describe('event normalization', () => {
  it('treats all-day end dates as exclusive and does not consume timed capacity', () => {
    const items = [{id: 'holiday', summary: 'Holiday', start: {date: '2026-10-14'}, end: {date: '2026-10-15'}}];
    const today = normalizeEvents(items, 'primary', '2026-10-14');
    expect(today).toHaveLength(1);
    expect(today[0]).toMatchObject({allDay: true, busy: false});
    expect(normalizeEvents(items, 'primary', '2026-10-15')).toHaveLength(0);
    const trip = [{id: 'trip', start: {date: '2026-10-12'}, end: {date: '2026-10-17'}}];
    expect(normalizeEvents(trip, 'primary', '2026-10-14')).toHaveLength(1);
  });

  it('drops cancelled, declined and working-location entries; keeps free events as non-busy', () => {
    const base = {start: {dateTime: '2026-10-14T10:00:00-07:00'}, end: {dateTime: '2026-10-14T11:00:00-07:00'}};
    const out = normalizeEvents(
      [
        {id: 'cancelled', status: 'cancelled', ...base},
        {id: 'declined', attendees: [{self: true, responseStatus: 'declined'}, {responseStatus: 'accepted'}], ...base},
        {id: 'where', eventType: 'workingLocation', ...base},
        {id: 'free', transparency: 'transparent', ...base},
        {id: 'real', attendees: [{self: true, responseStatus: 'accepted'}], ...base}
      ],
      'primary',
      '2026-10-14'
    );
    expect(out.map((e) => [e.id, e.busy])).toEqual([
      ['free', false],
      ['real', true]
    ]);
  });

  it('never carries descriptions, locations or attendee identities', () => {
    const out = normalizeEvents(
      [{id: 'x', summary: 'Sync', description: 'private notes', location: 'Home', attendees: [{email: 'friend@example.com', self: false}], start: {dateTime: '2026-10-14T10:00:00-07:00'}, end: {dateTime: '2026-10-14T10:30:00-07:00'}} as never],
      'primary',
      '2026-10-14'
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain('private notes');
    expect(text).not.toContain('friend@example.com');
    expect(text).not.toContain('Home');
  });
});

describe('token protection', () => {
  it('round-trips with AES-GCM and rejects tampering or another owner', () => {
    const c = encryptSecret('refresh', 'user-a:google_calendar');
    expect(c).not.toContain('refresh');
    expect(decryptSecret(c, 'user-a:google_calendar')).toBe('refresh');
    expect(() => decryptSecret(c, 'user-b:google_calendar')).toThrow();
    const parts = c.split('.');
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptSecret(parts.join('.'), 'user-a:google_calendar')).toThrow();
  });

  it('accepts only read-only calendar grants', () => {
    expect(scopeIsReadOnly(CALENDAR_SCOPE)).toBe(true);
    expect(scopeIsReadOnly(`${CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar`)).toBe(false);
    expect(scopeIsReadOnly(`${CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar.events`)).toBe(false);
    expect(scopeIsReadOnly('https://www.googleapis.com/auth/calendar.events.readonly')).toBe(false);
  });
});

describe('Google Calendar reads', () => {
  it('reports not_connected when no credential is stored', async () => {
    const {health, events} = await fetchCalendarEvents(userId, '2026-10-14');
    expect(health.state).toBe('not_connected');
    expect(events).toEqual([]);
  });

  it('expands recurrence, paginates and merges calendars', async () => {
    await storeToken('refresh-token-plaintext', ['primary', 'family@group.calendar.google.com']);
    const {impl, calls} = mockFetch([
      ['oauth2.googleapis.com/token', () => json({access_token: 'access-1', expires_in: 3600})],
      ['/calendars/primary/events', (url) =>
        url.searchParams.get('pageToken')
          ? json({items: [{id: 'standup_20261014T190000Z', recurringEventId: 'standup', iCalUID: 'standup@google', start: {dateTime: '2026-10-14T12:00:00-07:00'}, end: {dateTime: '2026-10-14T12:15:00-07:00'}}]})
          : json({items: [{id: 'standup_20261014T160000Z', recurringEventId: 'standup', iCalUID: 'standup@google', start: {dateTime: '2026-10-14T09:00:00-07:00'}, end: {dateTime: '2026-10-14T09:15:00-07:00'}}], nextPageToken: 'page-2'})],
      ['/calendars/family%40group.calendar.google.com/events', () => json({items: [{id: 'dup', iCalUID: 'standup@google', start: {dateTime: '2026-10-14T09:00:00-07:00'}, end: {dateTime: '2026-10-14T09:15:00-07:00'}}]})]
    ]);
    const {events, health} = await fetchCalendarEvents(userId, '2026-10-14', {fetchImpl: impl, ...fast});
    expect(health.state).toBe('connected');
    expect(events.map((e) => e.start)).toEqual(['2026-10-14T09:00:00.000-07:00', '2026-10-14T12:00:00.000-07:00']);
    const list = calls.find((c) => c.url.includes('/calendars/primary/events'))!;
    const q = new URL(list.url).searchParams;
    expect(q.get('singleEvents')).toBe('true');
    expect(q.get('timeMin')).toBe('2026-10-14T07:00:00.000Z');
    expect(q.get('timeMax')).toBe('2026-10-15T07:00:00.000Z');
    expect(q.get('fields')).not.toContain('description');
    expect(calls.every((c) => c.init.method !== 'PATCH' && c.init.method !== 'PUT' && c.init.method !== 'DELETE')).toBe(true);
  });

  it('marks a revoked refresh token, returns an error, and stops calling Google', async () => {
    await storeToken();
    const {impl, calls} = mockFetch([['oauth2.googleapis.com/token', () => json({error: 'invalid_grant', error_description: 'Token has been expired or revoked.'}, 400)]]);
    const first = await fetchCalendarEvents(userId, '2026-10-14', {fetchImpl: impl, ...fast});
    expect(first.health.state).toBe('error');
    expect(first.health.message).toMatch(/Reconnect/);
    expect(first.health.message).not.toContain('expired or revoked.');
    expect(first.events).toEqual([]);
    expect((await getCredential(userId, PROVIDER))!.status).toBe('revoked');
    const before = calls.length;
    const second = await fetchCalendarEvents(userId, '2026-10-14', {fetchImpl: impl, ...fast});
    expect(second.health.state).toBe('error');
    expect(calls.length).toBe(before);
  });

  it('surfaces provider outages as errors without fabricated events', async () => {
    await storeToken();
    const {impl} = mockFetch([
      ['oauth2.googleapis.com/token', () => json({access_token: 'a'})],
      ['/events', () => json({error: {message: 'Backend Error'}}, 503)]
    ]);
    const {health, events} = await fetchCalendarEvents(userId, '2026-10-14', {fetchImpl: impl, ...fast});
    expect(health.state).toBe('error');
    expect(events).toEqual([]);
    expect(health.message).not.toContain('Backend Error');
  });
});

describe('Google OAuth flow', () => {
  it('connect redirects with only calendar.readonly and a signed state cookie', async () => {
    const res = await connect(new Request('http://localhost:3000/api/google/connect', {method: 'POST', headers: {origin: 'http://localhost:3000'}}));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.host).toBe('accounts.google.com');
    expect(loc.searchParams.get('scope')).toBe(CALENDAR_SCOPE);
    expect(loc.searchParams.get('access_type')).toBe('offline');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/google/callback');
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
  });

  it('rejects a callback whose state is forged or belongs to someone else', async () => {
    const forged = signState({uid: 'other-user', nonce: 'n1', exp: Date.now() + 60000});
    const res = await callback(new Request(`http://localhost:3000/api/google/callback?code=c&state=${forged}`, {headers: {cookie: 'deevaa_gcal_nonce=n1'}}));
    expect(res.headers.get('location')).toContain('calendar=invalid_state');
    expect(await getCredential(userId, PROVIDER)).toBeNull();
  });

  it('stores only an encrypted refresh token after a valid callback', async () => {
    const {impl} = mockFetch([
      ['oauth2.googleapis.com/token', () => json({access_token: 'acc', refresh_token: 'rt-plaintext-123', scope: CALENDAR_SCOPE})],
      ['calendarList', () => json({items: [{id: 'me@example.com', primary: true}, {id: 'team@group', selected: true}, {id: 'hidden@group', selected: true, hidden: true}]})]
    ]);
    vi.stubGlobal('fetch', impl);
    const state = signState({uid: userId, nonce: 'n2', exp: Date.now() + 60000});
    const res = await callback(new Request(`http://localhost:3000/api/google/callback?code=c&state=${state}`, {headers: {cookie: 'deevaa_gcal_nonce=n2'}}));
    expect(res.headers.get('location')).toContain('calendar=connected');
    const cred = (await getCredential(userId, PROVIDER))!;
    expect(cred.encryptedRefreshToken).not.toContain('rt-plaintext-123');
    expect(decryptSecret(cred.encryptedRefreshToken, `${userId}:${PROVIDER}`)).toBe('rt-plaintext-123');
    expect(cred.calendarIds).toEqual(['primary', 'team@group']);
  });

  it('refuses grants broader than read-only', async () => {
    const {impl} = mockFetch([['oauth2.googleapis.com/token', () => json({access_token: 'a', refresh_token: 'r', scope: 'https://www.googleapis.com/auth/calendar'})]]);
    await expect(completeAuthorization(userId, 'code', {fetchImpl: impl, ...fast})).rejects.toMatchObject({kind: 'scope'});
    expect(await getCredential(userId, PROVIDER)).toBeNull();
  });
});
