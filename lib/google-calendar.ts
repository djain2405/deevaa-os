import {decryptSecret, encryptSecret} from './crypto';
import {logEvent} from './log';
import {providerFetch, type FetchOptions} from './provider-fetch';
import {getCredential, markCredentialRevoked, saveCredential} from './store';
import {dayBounds, parseEventTime} from './time';
import {TIMEZONE, type CalendarEvent, type SourceHealth} from './types';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const PROVIDER = 'google_calendar';
export const STATE_COOKIE = 'deevaa_gcal_nonce';
const MAX_CALENDARS = 10;
const MAX_EVENT_PAGES = 10;
const EVENT_FIELDS = 'nextPageToken,items(id,iCalUID,status,summary,start,end,transparency,eventType,htmlLink,attendees(self,responseStatus))';

export class GoogleError extends Error {
  constructor(public kind: 'revoked' | 'unavailable' | 'config' | 'scope' | 'no_refresh_token', message: string) {
    super(message);
  }
}

const aad = (userId: string) => `${userId}:${PROVIDER}`;

function clientConfig() {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret || !process.env.APP_URL) throw new GoogleError('config', 'Google OAuth is not configured.');
  return {clientId, clientSecret, redirectUri: new URL('/api/google/callback', process.env.APP_URL).toString()};
}

export function buildAuthUrl(state: string, loginHint?: string) {
  const {clientId, redirectUri} = clientConfig();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    ...(loginHint ? {login_hint: loginHint} : {})
  }).toString();
  return url.toString();
}

/** Rejects grants that include any calendar scope broader than read-only. */
export function scopeIsReadOnly(scope: string) {
  const scopes = scope.split(/\s+/).filter(Boolean);
  if (!scopes.includes(CALENDAR_SCOPE)) return false;
  return scopes.every((s) => !s.startsWith('https://www.googleapis.com/auth/calendar') || s.endsWith('.readonly'));
}

async function tokenRequest(op: string, params: Record<string, string>, opts: FetchOptions) {
  const res = await providerFetch(op, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(params)
  }, opts).catch(() => {
    throw new GoogleError('unavailable', 'Could not reach Google.');
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body?.error === 'invalid_grant' || res.status === 401) throw new GoogleError('revoked', 'Google Calendar access was revoked or expired. Reconnect Google Calendar.');
    throw new GoogleError('unavailable', 'Google rejected the token request.');
  }
  return body as {access_token: string; refresh_token?: string; scope?: string};
}

export async function listCalendarIds(accessToken: string, opts: FetchOptions = {}) {
  const res = await providerFetch('gcal.calendar_list', 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&fields=items(id,primary,selected,hidden)', {
    headers: {Authorization: `Bearer ${accessToken}`}
  }, opts);
  if (!res.ok) return ['primary'];
  const body = await res.json();
  const ids = (body.items ?? [])
    .filter((c: {primary?: boolean; selected?: boolean; hidden?: boolean}) => c.primary || (c.selected && !c.hidden))
    .map((c: {id: string; primary?: boolean}) => (c.primary ? 'primary' : c.id));
  return ids.length ? ids.slice(0, MAX_CALENDARS) : ['primary'];
}

/** Exchanges the code, verifies scope, and stores only the encrypted refresh token. */
export async function completeAuthorization(userId: string, code: string, opts: FetchOptions = {}) {
  const {clientId, clientSecret, redirectUri} = clientConfig();
  const token = await tokenRequest('gcal.token.exchange', {code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code'}, opts);
  if (!token.scope || !scopeIsReadOnly(token.scope)) throw new GoogleError('scope', 'Google granted unexpected permissions; only read-only calendar access is accepted.');
  if (!token.refresh_token) throw new GoogleError('no_refresh_token', 'Google did not return offline access. Remove Deevaa from your Google account permissions and connect again.');
  const calendarIds = await listCalendarIds(token.access_token, opts);
  await saveCredential({
    userId,
    provider: PROVIDER,
    encryptedRefreshToken: encryptSecret(token.refresh_token, aad(userId)),
    scope: CALENDAR_SCOPE,
    calendarIds
  });
  return {calendarCount: calendarIds.length};
}

export async function revokeAndForget(userId: string, opts: FetchOptions = {}) {
  const cred = await getCredential(userId, PROVIDER);
  if (!cred) return;
  try {
    const refresh = decryptSecret(cred.encryptedRefreshToken, aad(userId));
    await providerFetch('gcal.revoke', 'https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({token: refresh})
    }, {...opts, retries: 0});
  } catch {
    logEvent('warn', 'gcal.revoke', {status: 'failed'});
  }
}

type GoogleEvent = {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  start?: {dateTime?: string; date?: string};
  end?: {dateTime?: string; date?: string};
  transparency?: string;
  eventType?: string;
  htmlLink?: string;
  attendees?: {self?: boolean; responseStatus?: string}[];
};

/**
 * Keeps only what the planner and UI need. Descriptions, locations and attendee identities are never read
 * into the result. Cancelled, declined and working-location entries are dropped; transparent and all-day
 * events are shown but do not consume timed capacity.
 */
export function normalizeEvents(items: GoogleEvent[], calendarId: string, date: string): CalendarEvent[] {
  const {start: dayStart, end: dayEnd} = dayBounds(date);
  const out: CalendarEvent[] = [];
  for (const item of items) {
    if (item.status === 'cancelled' || item.eventType === 'workingLocation') continue;
    if (item.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue;
    const start = parseEventTime(item.start);
    const end = parseEventTime(item.end);
    if (!start || !end || end.time <= start.time) continue;
    if (end.time <= dayStart || start.time >= dayEnd) continue;
    out.push({
      id: item.id,
      calendarId,
      title: (item.summary ?? '').slice(0, 200) || 'Busy',
      start: start.time.toISO()!,
      end: end.time.toISO()!,
      allDay: start.allDay,
      busy: !start.allDay && item.transparency !== 'transparent',
      htmlLink: item.htmlLink ?? null,
      source: 'google_calendar'
    });
  }
  return out;
}

function dedupeEvents(events: (CalendarEvent & {uid: string})[]) {
  const seen = new Map<string, CalendarEvent>();
  for (const {uid, ...e} of events) {
    const key = `${uid}|${e.start}`;
    const prev = seen.get(key);
    if (!prev || (!prev.busy && e.busy)) seen.set(key, e);
  }
  return [...seen.values()].sort((a, b) => a.start.localeCompare(b.start));
}

async function readCalendar(accessToken: string, calendarId: string, date: string, opts: FetchOptions) {
  const {start, end} = dayBounds(date);
  const items: (CalendarEvent & {uid: string})[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const q = new URLSearchParams({
      timeMin: start.toUTC().toISO()!,
      timeMax: end.toUTC().toISO()!,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      showDeleted: 'false',
      timeZone: TIMEZONE,
      fields: EVENT_FIELDS
    });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await providerFetch('gcal.events.list', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`, {
      headers: {Authorization: `Bearer ${accessToken}`}
    }, opts);
    if (res.status === 401) throw new GoogleError('revoked', 'Google Calendar access was revoked or expired. Reconnect Google Calendar.');
    if (!res.ok) throw new GoogleError('unavailable', `status ${res.status}`);
    const body = await res.json();
    const raw: GoogleEvent[] = body.items ?? [];
    const normalized = normalizeEvents(raw, calendarId, date);
    const uidById = new Map(raw.map((r) => [r.id, r.iCalUID ?? r.id]));
    items.push(...normalized.map((e) => ({...e, uid: uidById.get(e.id) ?? e.id})));
    pageToken = body.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_EVENT_PAGES);
  return {items, truncated: Boolean(pageToken)};
}

export async function fetchCalendarEvents(userId: string, date: string, opts: FetchOptions = {}): Promise<{events: CalendarEvent[]; health: SourceHealth}> {
  const cred = await getCredential(userId, PROVIDER);
  if (!cred) {
    return {events: [], health: {state: 'not_connected', message: 'Google Calendar is not connected. Free time is unknown.', lastSyncedAt: null, count: 0, warnings: []}};
  }
  if (cred.status === 'revoked') {
    return {events: [], health: {state: 'error', message: 'Google Calendar access was revoked. Reconnect Google Calendar.', lastSyncedAt: null, count: 0, warnings: []}};
  }
  const warnings: string[] = [];
  try {
    const {clientId, clientSecret} = clientConfig();
    const refresh = decryptSecret(cred.encryptedRefreshToken, aad(userId));
    const {access_token} = await tokenRequest('gcal.token.refresh', {client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: 'refresh_token'}, opts);
    const all: (CalendarEvent & {uid: string})[] = [];
    let failed = 0;
    for (const calendarId of cred.calendarIds.length ? cred.calendarIds : ['primary']) {
      try {
        const {items, truncated} = await readCalendar(access_token, calendarId, date, opts);
        all.push(...items);
        if (truncated) warnings.push('A calendar had more events than could be read; some events may be missing.');
      } catch (e) {
        if (e instanceof GoogleError && e.kind === 'revoked') throw e;
        failed++;
      }
    }
    if (failed && failed === (cred.calendarIds.length || 1)) throw new GoogleError('unavailable', 'Google Calendar could not be read.');
    if (failed) warnings.push(`${failed} calendar(s) could not be read; free time may be overstated.`);
    const events = dedupeEvents(all);
    return {events, health: {state: 'connected', message: `Read ${events.length} event(s) from ${cred.calendarIds.length || 1} calendar(s).`, lastSyncedAt: new Date().toISOString(), count: events.length, warnings}};
  } catch (e) {
    const err = e instanceof GoogleError ? e : new GoogleError('unavailable', 'Google Calendar could not be read.');
    if (err.kind === 'revoked') await markCredentialRevoked(userId, PROVIDER);
    logEvent('error', 'gcal.fetch', {kind: err.kind});
    const message = err.kind === 'revoked' ? err.message : err.kind === 'config' ? 'Google OAuth is not configured on the server.' : 'Google Calendar could not be read right now.';
    return {events: [], health: {state: 'error', message, lastSyncedAt: null, count: 0, warnings}};
  }
}
