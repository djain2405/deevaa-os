import {logEvent} from './log';
import {providerFetch, type FetchOptions} from './provider-fetch';
import type {Context, Energy, Priority, SourceHealth, Task, TaskStatus} from './types';

export const NOTION_VERSION = '2025-09-03';
const API = 'https://api.notion.com/v1';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** Minimum schema: a title property and `Status` (select or status). Everything else is optional. */
export const NOTION_SCHEMA = {
  Name: {title: {}},
  Status: {
    select: {
      options: ['Inbox', 'Ready', 'In Progress', 'Waiting', 'Waiting for User', 'Blocked', 'Done', 'Canceled', 'Needs Verification'].map(
        (name) => ({name})
      )
    }
  },
  Priority: {select: {options: ['Urgent', 'High', 'Medium', 'Low'].map((name) => ({name}))}},
  Due: {date: {}},
  Duration: {number: {format: 'number'}},
  Context: {select: {options: ['Anywhere', 'Phone', 'Laptop', 'Home'].map((name) => ({name}))}},
  Energy: {select: {options: ['Low', 'Medium', 'High'].map((name) => ({name}))}},
  Blocker: {rich_text: {}},
  ExternalKey: {rich_text: {}},
  SourceLink: {url: {}},
  Project: {rich_text: {}},
  NextAction: {rich_text: {}},
  LastVerified: {date: {}}
} as const;

export type NotionConfig = {token?: string; dataSourceId?: string; databaseId?: string};

export class NotionError extends Error {
  constructor(public status: number | 'network' | 'schema', message: string) {
    super(message);
  }
}

function headers(token: string) {
  return {Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json'};
}

function userMessage(status: number) {
  if (status === 401) return 'Notion rejected the integration token. It may be revoked; create a new token and update NOTION_TOKEN.';
  if (status === 403) return 'The Notion integration lacks access. Share the Deevaa Tasks database with the integration.';
  if (status === 404) return 'Notion database or data source not found, or not shared with the integration.';
  if (status === 429) return 'Notion is rate-limiting requests. Try again shortly.';
  return 'Notion is unavailable right now.';
}

async function call(op: string, url: string, init: RequestInit, opts: FetchOptions) {
  let res: Response;
  try {
    res = await providerFetch(op, url, init, opts);
  } catch {
    throw new NotionError('network', 'Could not reach Notion.');
  }
  if (!res.ok) throw new NotionError(res.status, userMessage(res.status));
  return res.json();
}

export async function resolveDataSourceId(cfg: NotionConfig, opts: FetchOptions = {}) {
  if (cfg.dataSourceId) return cfg.dataSourceId;
  if (!cfg.databaseId || !cfg.token) throw new NotionError('schema', 'Notion is not configured.');
  const db = await call('notion.database.retrieve', `${API}/databases/${cfg.databaseId}`, {headers: headers(cfg.token)}, opts);
  const id = db?.data_sources?.[0]?.id;
  if (!id) throw new NotionError('schema', 'The Notion database has no data source.');
  return id as string;
}

type PropertySchema = Record<string, {type: string; id: string}>;

export function checkSchema(properties: PropertySchema) {
  const title = Object.entries(properties).find(([, p]) => p.type === 'title')?.[0] ?? null;
  const status = properties.Status && ['select', 'status'].includes(properties.Status.type) ? 'Status' : null;
  const missing = Object.keys(NOTION_SCHEMA).filter((name) => name !== 'Name' && !properties[name]);
  return {title, status, missing, ok: Boolean(title && status)};
}

const STATUS_MAP: Record<string, TaskStatus> = {
  inbox: 'Inbox',
  backlog: 'Inbox',
  capture: 'Inbox',
  ready: 'Ready',
  'not started': 'Ready',
  'to do': 'Ready',
  todo: 'Ready',
  next: 'Ready',
  'in progress': 'In Progress',
  doing: 'In Progress',
  started: 'In Progress',
  waiting: 'Waiting',
  'waiting on': 'Waiting',
  pending: 'Waiting',
  'waiting for user': 'Waiting for User',
  'needs you': 'Waiting for User',
  blocked: 'Blocked',
  done: 'Done',
  complete: 'Done',
  completed: 'Done',
  canceled: 'Canceled',
  cancelled: 'Canceled',
  "won't do": 'Canceled',
  'needs verification': 'Needs Verification'
};

export function normalizeStatus(raw: string | null | undefined): TaskStatus {
  if (!raw || !raw.trim()) return 'Inbox';
  return STATUS_MAP[raw.trim().toLowerCase()] ?? 'Needs Verification';
}

export function normalizePriority(raw: string | null | undefined): Priority {
  const v = raw?.trim().toLowerCase() ?? '';
  if (['urgent', 'p0', 'critical'].includes(v)) return 'Urgent';
  if (['high', 'p1'].includes(v)) return 'High';
  if (['medium', 'p2', 'normal'].includes(v)) return 'Medium';
  if (['low', 'p3'].includes(v)) return 'Low';
  return 'None';
}

const pick = <T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T =>
  (allowed.find((a) => a.toLowerCase() === raw?.trim().toLowerCase()) ?? fallback) as T;

const text = (rich: unknown) =>
  Array.isArray(rich) ? rich.map((r: {plain_text?: string}) => r.plain_text ?? '').join('').trim() : '';

function optionName(prop: any): string | null {
  if (!prop) return null;
  if (prop.type === 'select') return prop.select?.name ?? null;
  if (prop.type === 'status') return prop.status?.name ?? null;
  if (prop.type === 'multi_select') return prop.multi_select?.[0]?.name ?? null;
  return null;
}

export function mapPage(page: any): Task | null {
  if (page?.object !== 'page' || page.in_trash || page.is_archived || page.archived) return null;
  const p = page.properties ?? {};
  const titleProp = Object.values(p).find((v: any) => v?.type === 'title') as any;
  const rawStatus = optionName(p.Status);
  const duration = p.Duration?.type === 'number' && typeof p.Duration.number === 'number' && p.Duration.number > 0 ? Math.round(p.Duration.number) : null;
  return {
    id: page.id,
    title: text(titleProp?.title) || 'Untitled task',
    status: normalizeStatus(rawStatus),
    rawStatus,
    priority: normalizePriority(optionName(p.Priority)),
    due: p.Due?.date?.start ?? null,
    duration,
    context: pick<Context>(optionName(p.Context), ['Anywhere', 'Phone', 'Laptop', 'Home'], 'Anywhere'),
    energy: pick<Energy>(optionName(p.Energy), ['Low', 'Medium', 'High'], 'Medium'),
    blocker: p.Blocker?.type === 'rich_text' ? text(p.Blocker.rich_text) || null : null,
    blockedBy: p['Blocked By']?.type === 'relation' ? (p['Blocked By'].relation ?? []).map((r: {id: string}) => r.id) : [],
    externalKey: p.ExternalKey?.type === 'rich_text' ? text(p.ExternalKey.rich_text) || null : null,
    project: p.Project?.type === 'rich_text' ? text(p.Project.rich_text) || null : p.Project?.type === 'select' ? p.Project.select?.name ?? null : null,
    nextAction: p.NextAction?.type === 'rich_text' ? text(p.NextAction.rich_text) || null : null,
    url: page.url,
    sourceLink: p.SourceLink?.type === 'url' ? p.SourceLink.url ?? null : null,
    source: 'notion',
    lastEditedAt: page.last_edited_time ?? new Date(0).toISOString()
  };
}

/** Page id first, then ExternalKey; the most recently edited record wins. */
export function dedupeTasks(tasks: Task[]) {
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  const byKey = new Map<string, Task>();
  const out: Task[] = [];
  for (const t of byId.values()) {
    if (!t.externalKey) {
      out.push(t);
      continue;
    }
    const prev = byKey.get(t.externalKey);
    if (!prev || prev.lastEditedAt < t.lastEditedAt) byKey.set(t.externalKey, t);
  }
  return [...out, ...byKey.values()];
}

/** Accepts a raw id (with or without dashes) or a copied Notion link and returns the dashed id. */
export function notionId(input: string | undefined): string | undefined {
  const raw = input?.trim();
  if (!raw) return undefined;
  const path = raw.split(/[?#]/)[0];
  const ids = path.match(/(?<![0-9a-f])(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/gi);
  const hex = ids?.at(-1)?.replace(/-/g, '').toLowerCase();
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : raw;
}

export function notionConfigFromEnv(): NotionConfig {
  return {
    token: process.env.NOTION_TOKEN || undefined,
    dataSourceId: notionId(process.env.NOTION_DATA_SOURCE_ID),
    databaseId: notionId(process.env.NOTION_DATABASE_ID)
  };
}

export async function fetchNotionTasks(
  cfg: NotionConfig = notionConfigFromEnv(),
  opts: FetchOptions = {}
): Promise<{tasks: Task[]; health: SourceHealth}> {
  if (!cfg.token || (!cfg.dataSourceId && !cfg.databaseId)) {
    return {
      tasks: [],
      health: {state: 'not_connected', message: 'Notion is not connected. Set NOTION_TOKEN and NOTION_DATA_SOURCE_ID.', lastSyncedAt: null, count: 0, warnings: []}
    };
  }
  const warnings: string[] = [];
  try {
    const dataSourceId = await resolveDataSourceId(cfg, opts);
    const ds = await call('notion.data_source.retrieve', `${API}/data_sources/${dataSourceId}`, {headers: headers(cfg.token)}, opts);
    const schema = checkSchema(ds?.properties ?? {});
    if (!schema.ok) {
      throw new NotionError('schema', 'The Notion data source is missing a title or a Status (select or status) property. Run npm run notion:setup.');
    }
    const optional = schema.missing.filter((m) => m !== 'Status');
    if (optional.length) warnings.push(`Notion is missing optional properties: ${optional.join(', ')}. Planning uses defaults for them.`);

    const raw: Task[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const body: Record<string, unknown> = {page_size: PAGE_SIZE, sorts: [{timestamp: 'last_edited_time', direction: 'descending'}]};
      if (cursor) body.start_cursor = cursor;
      const res = await call(
        'notion.data_source.query',
        `${API}/data_sources/${dataSourceId}/query`,
        {method: 'POST', headers: headers(cfg.token), body: JSON.stringify(body)},
        opts
      );
      for (const page of res.results ?? []) {
        const task = mapPage(page);
        if (task) raw.push(task);
      }
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
      pages++;
    } while (cursor && pages < MAX_PAGES);
    if (cursor) warnings.push(`Notion has more than ${PAGE_SIZE * MAX_PAGES} tasks; only the most recently edited were considered.`);

    const tasks = dedupeTasks(raw);
    if (tasks.length < raw.length) warnings.push(`${raw.length - tasks.length} duplicate Notion record(s) were merged by ExternalKey.`);
    const missingDuration = tasks.filter((t) => !['Done', 'Canceled'].includes(t.status) && t.duration === null).length;
    if (missingDuration) warnings.push(`${missingDuration} open task(s) have no Duration in Notion; estimates are assumed.`);
    return {
      tasks,
      health: {state: 'connected', message: `Read ${tasks.length} task(s) from Notion.`, lastSyncedAt: new Date().toISOString(), count: tasks.length, warnings}
    };
  } catch (e) {
    const err = e instanceof NotionError ? e : new NotionError('network', 'Notion read failed.');
    logEvent('error', 'notion.fetch', {status: String(err.status)});
    return {tasks: [], health: {state: 'error', message: err.message, lastSyncedAt: null, count: 0, warnings}};
  }
}
