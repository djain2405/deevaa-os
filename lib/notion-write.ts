import {mapPage, normalizePriority, normalizeStatus, NOTION_VERSION, notionConfigFromEnv, resolveDataSourceId, type NotionConfig} from './notion';
import {providerFetch, type FetchOptions} from './provider-fetch';
import type {Context, Energy, Priority, Task, TaskStatus} from './types';

const API = 'https://api.notion.com/v1';

/** Fields Deevaa may write on a task. Anything else in Notion is left untouched. */
export type TaskFields = {
  title?: string;
  status?: TaskStatus;
  priority?: Exclude<Priority, 'None'> | null;
  due?: string | null;
  duration?: number | null;
  context?: Context | null;
  energy?: Energy | null;
  project?: string | null;
  nextAction?: string | null;
  externalKey?: string | null;
  sourceLink?: string | null;
  blocker?: string | null;
};

export type WriteErrorCode = 'not_configured' | 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'unavailable' | 'rejected' | 'schema' | 'verify_failed';

export class NotionWriteError extends Error {
  constructor(public code: WriteErrorCode, message: string) {
    super(message);
  }
}

const MESSAGES: Record<WriteErrorCode, string> = {
  not_configured: 'Notion is not configured on the server.',
  unauthorized: 'Notion rejected the integration token. Create a new token and update NOTION_TOKEN.',
  forbidden: 'The Notion connection is not allowed to write. Turn on Insert content and Update content for the Deevaa OS connection and keep Deevaa Tasks shared with it.',
  not_found: 'The Notion page or database was not found, or is no longer shared with the connection.',
  rate_limited: 'Notion is rate-limiting requests. Nothing more was written; try again shortly.',
  unavailable: 'Notion could not be reached. The change may not have been saved.',
  rejected: 'Notion rejected the task fields.',
  schema: 'The Notion database is missing a property Deevaa needs. Run npm run notion:setup -- --fix.',
  verify_failed: 'Notion accepted the request, but reading the page back did not show the change.'
};

export const notionWriteError = (code: WriteErrorCode) => new NotionWriteError(code, MESSAGES[code]);
const fail = notionWriteError;

function codeFor(status: number): WriteErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 409) return 'rejected';
  return 'unavailable';
}

const headers = (token: string) => ({Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json'});

async function call(op: string, url: string, init: RequestInit, opts: FetchOptions) {
  let res: Response;
  try {
    res = await providerFetch(op, url, init, opts);
  } catch {
    throw fail('unavailable');
  }
  if (!res.ok) throw fail(codeFor(res.status));
  return res.json();
}

type PropType = {type: string; options: string[]};
export type WriteTarget = {token: string; dataSourceId: string; titleProperty: string; props: Record<string, PropType>};

export async function loadWriteTarget(cfg: NotionConfig = notionConfigFromEnv(), opts: FetchOptions = {}): Promise<WriteTarget> {
  if (!cfg.token || (!cfg.dataSourceId && !cfg.databaseId)) throw fail('not_configured');
  let dataSourceId: string;
  try {
    dataSourceId = await resolveDataSourceId(cfg, opts);
  } catch {
    throw fail('not_found');
  }
  const ds = await call('notion.write.schema', `${API}/data_sources/${dataSourceId}`, {headers: headers(cfg.token)}, opts);
  const props: Record<string, PropType> = {};
  let titleProperty: string | null = null;
  for (const [name, p] of Object.entries<any>(ds?.properties ?? {})) {
    if (p?.type === 'title') titleProperty = name;
    const options = (p?.[p?.type]?.options ?? []).map((o: {name: string}) => o.name);
    props[name] = {type: p?.type, options};
  }
  if (!titleProperty || !['select', 'status'].includes(props.Status?.type ?? '')) throw fail('schema');
  return {token: cfg.token, dataSourceId, titleProperty, props};
}

const rich = (value: string | null | undefined) => ({rich_text: value ? [{type: 'text', text: {content: value.slice(0, 2000)}}] : []});

function statusOption(target: WriteTarget, status: TaskStatus) {
  const prop = target.props.Status;
  const existing = prop.options.find((o) => normalizeStatus(o) === status);
  if (existing) return existing;
  if (prop.type === 'status') throw fail('schema');
  return status;
}

/** Builds Notion properties for the fields that exist in the target; returns the field names it had to skip. */
export function buildProperties(target: WriteTarget, fields: TaskFields) {
  const properties: Record<string, unknown> = {};
  const skipped: string[] = [];
  const has = (name: string, type: string) => target.props[name]?.type === type;
  const set = (name: string, type: string, value: unknown) => (has(name, type) ? (properties[name] = value) : skipped.push(name));

  if (fields.title !== undefined) properties[target.titleProperty] = {title: [{type: 'text', text: {content: fields.title.slice(0, 2000)}}]};
  if (fields.status !== undefined) {
    const name = statusOption(target, fields.status);
    properties.Status = target.props.Status.type === 'status' ? {status: {name}} : {select: {name}};
  }
  if (fields.priority !== undefined) {
    const option = fields.priority && (target.props.Priority?.options.find((o) => normalizePriority(o) === fields.priority) ?? fields.priority);
    set('Priority', 'select', {select: option ? {name: option} : null});
  }
  if (fields.due !== undefined) set('Due', 'date', {date: fields.due ? {start: fields.due} : null});
  if (fields.duration !== undefined) set('Duration', 'number', {number: fields.duration});
  if (fields.context !== undefined) set('Context', 'select', {select: fields.context ? {name: fields.context} : null});
  if (fields.energy !== undefined) set('Energy', 'select', {select: fields.energy ? {name: fields.energy} : null});
  if (fields.project !== undefined) set('Project', 'rich_text', rich(fields.project));
  if (fields.nextAction !== undefined) set('NextAction', 'rich_text', rich(fields.nextAction));
  if (fields.externalKey !== undefined) set('ExternalKey', 'rich_text', rich(fields.externalKey));
  if (fields.blocker !== undefined) set('Blocker', 'rich_text', rich(fields.blocker));
  if (fields.sourceLink !== undefined) set('SourceLink', 'url', {url: fields.sourceLink});
  if (has('LastVerified', 'date')) properties.LastVerified = {date: {start: new Date().toISOString()}};
  return {properties, skipped};
}

/** Field names whose value on the page does not match what was written. */
export function mismatches(task: Task, fields: TaskFields, skipped: string[] = []) {
  const out: string[] = [];
  const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);
  const check = (name: string, ok: boolean) => !skipped.includes(name) && !ok && out.push(name);
  if (fields.title !== undefined) check('title', task.title === fields.title.slice(0, 2000).trim());
  if (fields.status !== undefined) check('Status', task.status === fields.status);
  if (fields.priority !== undefined) check('Priority', task.priority === (fields.priority ?? 'None'));
  if (fields.due !== undefined) check('Due', day(task.due) === day(fields.due));
  if (fields.duration !== undefined) check('Duration', task.duration === (fields.duration ?? null));
  if (fields.project !== undefined) check('Project', (task.project ?? null) === (fields.project || null));
  if (fields.nextAction !== undefined) check('NextAction', (task.nextAction ?? null) === (fields.nextAction || null));
  if (fields.externalKey !== undefined) check('ExternalKey', (task.externalKey ?? null) === (fields.externalKey || null));
  return out;
}

export async function retrieveTask(target: WriteTarget, pageId: string, opts: FetchOptions = {}): Promise<{task: Task | null; trashed: boolean}> {
  const page = await call('notion.page.retrieve', `${API}/pages/${pageId}`, {headers: headers(target.token)}, opts);
  const task = mapPage(page);
  return {task, trashed: !task};
}

async function verify(target: WriteTarget, pageId: string, fields: TaskFields, skipped: string[], opts: FetchOptions) {
  const {task} = await retrieveTask(target, pageId, opts);
  if (!task || mismatches(task, fields, skipped).length) throw fail('verify_failed');
  return task;
}

export async function findByExternalKey(target: WriteTarget, key: string, opts: FetchOptions = {}): Promise<Task | null> {
  if (target.props.ExternalKey?.type !== 'rich_text') return null;
  const res = await call(
    'notion.page.lookup',
    `${API}/data_sources/${target.dataSourceId}/query`,
    {method: 'POST', headers: headers(target.token), body: JSON.stringify({page_size: 5, filter: {property: 'ExternalKey', rich_text: {equals: key}}})},
    opts
  );
  for (const page of res?.results ?? []) {
    const task = mapPage(page);
    if (task?.externalKey === key) return task;
  }
  return null;
}

/** Creates one task and reads it back. Creates are never retried blindly; callers recover through `findByExternalKey`. */
export async function createTask(target: WriteTarget, fields: TaskFields & {title: string}, opts: FetchOptions = {}) {
  const {properties, skipped} = buildProperties(target, fields);
  const page = await call(
    'notion.page.create',
    `${API}/pages`,
    {method: 'POST', headers: headers(target.token), body: JSON.stringify({parent: {type: 'data_source_id', data_source_id: target.dataSourceId}, properties})},
    {...opts, retries: 0}
  );
  if (!page?.id) throw fail('verify_failed');
  return {task: await verify(target, page.id, fields, skipped, opts), skipped};
}

export async function updateTask(target: WriteTarget, pageId: string, fields: TaskFields, opts: FetchOptions = {}) {
  const {properties, skipped} = buildProperties(target, fields);
  await call('notion.page.update', `${API}/pages/${pageId}`, {method: 'PATCH', headers: headers(target.token), body: JSON.stringify({properties})}, opts);
  return {task: await verify(target, pageId, fields, skipped, opts), skipped};
}

/** Moves a page to Notion's trash, where the user can still restore it. Used only to undo Deevaa's own create. */
export async function trashTask(target: WriteTarget, pageId: string, opts: FetchOptions = {}) {
  await call('notion.page.trash', `${API}/pages/${pageId}`, {method: 'PATCH', headers: headers(target.token), body: JSON.stringify({in_trash: true})}, opts);
  const {trashed} = await retrieveTask(target, pageId, opts);
  if (!trashed) throw fail('verify_failed');
}

/** The current values of the fields about to change, so an update can be reverted. */
export function snapshotFields(task: Task, fields: TaskFields): TaskFields {
  const out: TaskFields = {};
  if (fields.title !== undefined) out.title = task.title;
  if (fields.status !== undefined) out.status = task.status;
  if (fields.priority !== undefined) out.priority = task.priority === 'None' ? null : task.priority;
  if (fields.due !== undefined) out.due = task.due;
  if (fields.duration !== undefined) out.duration = task.duration;
  if (fields.project !== undefined) out.project = task.project;
  if (fields.nextAction !== undefined) out.nextAction = task.nextAction;
  if (fields.externalKey !== undefined) out.externalKey = task.externalKey;
  return out;
}
