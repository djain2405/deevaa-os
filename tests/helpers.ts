import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {setDbForTests, type Db} from '@/lib/db/client';
import {MIGRATIONS} from '@/lib/db/migrations';
import * as schema from '@/lib/db/schema';
import {getOrCreateUser} from '@/lib/store';
import type {CalendarEvent, SourceHealth, Task} from '@/lib/types';

export async function freshDb() {
  const client = new PGlite();
  for (const sql of MIGRATIONS) await client.exec(sql);
  const db = drizzle(client, {schema}) as unknown as Db;
  setDbForTests(db);
  return {db, client};
}

export const getUser = () => getOrCreateUser('owner@example.com');

let n = 0;
export function task(overrides: Partial<Task> = {}): Task {
  n++;
  return {
    id: `task-${n}`,
    title: `Task ${n}`,
    status: 'Ready',
    rawStatus: 'Ready',
    priority: 'Medium',
    due: null,
    duration: 30,
    context: 'Anywhere',
    energy: 'Low',
    blocker: null,
    blockedBy: [],
    externalKey: null,
    project: null,
    nextAction: null,
    url: `https://www.notion.so/task-${n}`,
    sourceLink: null,
    source: 'notion',
    lastEditedAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  };
}

export function event(start: string, end: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  n++;
  return {id: `evt-${n}`, calendarId: 'primary', title: `Event ${n}`, start, end, allDay: false, busy: true, htmlLink: null, source: 'google_calendar', ...overrides};
}

export const connected = (count = 0): SourceHealth => ({state: 'connected', message: 'ok', lastSyncedAt: '2026-10-14T05:00:00.000Z', count, warnings: []});
export const notConnected = (): SourceHealth => ({state: 'not_connected', message: 'Not connected.', lastSyncedAt: null, count: 0, warnings: []});
export const failed = (message = 'Provider failed.'): SourceHealth => ({state: 'error', message, lastSyncedAt: null, count: 0, warnings: []});

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Routes requests by URL substring; unmatched calls fail the test loudly. */
export function mockFetch(routes: [string, Route][]) {
  const calls: {url: string; init: RequestInit}[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({url: url.toString(), init});
    const hit = routes.find(([pattern]) => url.toString().includes(pattern));
    if (!hit) throw new Error(`Unexpected fetch ${url}`);
    return hit[1](url, init);
  }) as typeof fetch;
  return {impl, calls};
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
