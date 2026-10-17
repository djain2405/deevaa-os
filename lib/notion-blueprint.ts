import {BLUEPRINT_FIELDS, blueprintHasContent, emptyBlueprint, parseBlueprint, type Blueprint, type BlueprintField} from './blueprint';
import {hasPermission, latestBlueprint, NOTION_WRITE, saveBlueprint} from './intake-store';
import {logEvent} from './log';
import {NOTION_VERSION, notionId} from './notion';
import {NotionWriteError, notionWriteError, type WriteErrorCode} from './notion-write';
import {providerFetch, type FetchOptions} from './provider-fetch';
import {getBlueprintNotionPageId, setBlueprintNotionPageId} from './store';

const API = 'https://api.notion.com/v1';
const PAGE_TITLE = 'Life Blueprint';
const CHILD_BATCH = 100;

export type BlueprintNotionPublish = {
  status: 'published' | 'skipped' | 'failed';
  url: string | null;
  message: string;
};

type PublishDeps = FetchOptions & {
  token?: string;
  parentPageId?: string;
  storedPageId?: string | null;
  persistPageId?: (pageId: string) => Promise<void>;
  writeGranted?: boolean;
};

const headers = (token: string) => ({Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json'});

const rich = (content: string) => [{type: 'text', text: {content: content.slice(0, 2000)}}];

function heading2(text: string) {
  return {object: 'block', type: 'heading_2', heading_2: {rich_text: rich(text), is_toggleable: false}};
}

function bullet(text: string) {
  return {object: 'block', type: 'bulleted_list_item', bulleted_list_item: {rich_text: rich(text)}};
}

export function blueprintNotionBlocks(blueprint: Blueprint) {
  const children: Record<string, unknown>[] = [];
  for (const field of BLUEPRINT_FIELDS) {
    const lines = blueprint[field.key];
    if (!lines.length) continue;
    children.push(heading2(field.label));
    for (const line of lines) children.push(bullet(line));
  }
  return children;
}

export function notionPagePublicUrl(pageId: string) {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

function pageTitleFromProps(properties: Record<string, {type?: string; title?: {plain_text?: string}[]}>) {
  for (const p of Object.values(properties ?? {})) {
    if (p?.type === 'title') return (p.title ?? []).map((t) => t.plain_text ?? '').join('');
  }
  return '';
}

function blockPlainText(block: {type: string; [key: string]: unknown}) {
  const body = block[block.type];
  if (!body || typeof body !== 'object' || !('rich_text' in body)) return '';
  const rich = (body as {rich_text?: {plain_text?: string}[]}).rich_text ?? [];
  return rich.map((t) => t.plain_text ?? '').join('');
}

function codeFor(status: number): WriteErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 409) return 'rejected';
  return 'unavailable';
}

async function readBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw notionWriteError('unavailable');
  }
}

async function call(op: string, url: string, init: RequestInit, opts: FetchOptions) {
  let res: Response;
  try {
    res = await providerFetch(op, url, init, opts);
  } catch {
    throw notionWriteError('unavailable');
  }
  if (!res.ok) throw notionWriteError(codeFor(res.status));
  return readBody(res);
}

type NotionBlock = {id?: string; type?: string; [key: string]: any};

function normLabel(value: string) {
  return value.trim().replace(/['’`]/g, "'");
}

const LABEL_TO_FIELD = new Map(BLUEPRINT_FIELDS.map((f) => [normLabel(f.label), f.key]));

export function parseBlueprintFromNotionBlocks(blocks: NotionBlock[]): Blueprint {
  const data = emptyBlueprint();
  let field: BlueprintField | null = null;
  for (const block of blocks) {
    const type = typeof block?.type === 'string' ? block.type : '';
    const text = blockPlainText(block as {type: string; [key: string]: unknown}).trim();
    if (type === 'heading_2') {
      field = LABEL_TO_FIELD.get(normLabel(text)) ?? null;
      continue;
    }
    if (!field || !text) continue;
    if (type === 'bulleted_list_item' || type === 'numbered_list_item' || type === 'paragraph' || type === 'to_do') {
      if (!data[field].includes(text)) data[field] = [...data[field], text.slice(0, 240)].slice(-30);
    }
  }
  return parseBlueprint(data);
}

async function listBlockChildren(token: string, blockId: string, opts: FetchOptions) {
  const out: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const q = new URLSearchParams({page_size: '100'});
    if (cursor) q.set('start_cursor', cursor);
    const page = await call('notion.blueprint.list', `${API}/blocks/${blockId}/children?${q}`, {headers: headers(token)}, opts);
    for (const b of page?.results ?? []) {
      if (b?.id) out.push(b);
    }
    cursor = page?.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function clearBlockChildren(token: string, pageId: string, opts: FetchOptions) {
  const children = await listBlockChildren(token, pageId, opts);
  for (const {id} of children) {
    await call('notion.blueprint.archive', `${API}/blocks/${id}`, {method: 'PATCH', headers: headers(token), body: JSON.stringify({archived: true})}, opts);
  }
}

async function appendChildren(token: string, pageId: string, children: unknown[], opts: FetchOptions) {
  for (let i = 0; i < children.length; i += CHILD_BATCH) {
    const batch = children.slice(i, i + CHILD_BATCH);
    await call('notion.blueprint.append', `${API}/blocks/${pageId}/children`, {method: 'PATCH', headers: headers(token), body: JSON.stringify({children: batch})}, opts);
  }
}

async function verifyPage(token: string, pageId: string, blueprint: Blueprint, opts: FetchOptions) {
  const page = await call('notion.blueprint.verify.page', `${API}/pages/${pageId}`, {headers: headers(token)}, opts);
  const title = pageTitleFromProps(page?.properties ?? {});
  if (title.trim() !== PAGE_TITLE) throw notionWriteError('verify_failed');

  const expected = BLUEPRINT_FIELDS.filter((f) => blueprint[f.key].length);
  if (!expected.length) return;

  const q = new URLSearchParams({page_size: '100'});
  const blocks = await call('notion.blueprint.verify.children', `${API}/blocks/${pageId}/children?${q}`, {headers: headers(token)}, opts);
  const first = blocks?.results?.[0];
  if (!first || first.type !== 'heading_2') throw notionWriteError('verify_failed');
  if (blockPlainText(first) !== expected[0].label) throw notionWriteError('verify_failed');
}

async function createBlueprintPage(token: string, parentId: string, blueprint: Blueprint, opts: FetchOptions) {
  const children = blueprintNotionBlocks(blueprint);
  const body: Record<string, unknown> = {
    parent: {type: 'page_id', page_id: parentId},
    properties: {title: {title: rich(PAGE_TITLE)}},
    children: children.slice(0, CHILD_BATCH)
  };
  const page = await call('notion.blueprint.create', `${API}/pages`, {method: 'POST', headers: headers(token), body: JSON.stringify(body)}, opts);
  const pageId = typeof page?.id === 'string' ? page.id : '';
  if (!pageId) throw notionWriteError('verify_failed');
  const rest = children.slice(CHILD_BATCH);
  if (rest.length) await appendChildren(token, pageId, rest, opts);
  await verifyPage(token, pageId, blueprint, opts);
  return {pageId, url: typeof page?.url === 'string' ? page.url : notionPagePublicUrl(pageId)};
}

async function updateBlueprintPage(token: string, pageId: string, blueprint: Blueprint, opts: FetchOptions) {
  await clearBlockChildren(token, pageId, opts);
  const children = blueprintNotionBlocks(blueprint);
  if (children.length) await appendChildren(token, pageId, children, opts);
  await verifyPage(token, pageId, blueprint, opts);
  const page = await call('notion.blueprint.read', `${API}/pages/${pageId}`, {headers: headers(token)}, opts);
  return {pageId, url: typeof page?.url === 'string' ? page.url : notionPagePublicUrl(pageId)};
}

export async function publishLifeBlueprintToNotion(userId: string, blueprint: Blueprint, deps: PublishDeps = {}): Promise<BlueprintNotionPublish> {
  const opts: FetchOptions = {timeoutMs: 60_000, ...deps};
  try {
    const granted = deps.writeGranted ?? (await hasPermission(userId, NOTION_WRITE));
    if (!granted) {
      return {status: 'skipped', url: null, message: 'Life Blueprint saved here only. Turn on Notion task updates in Connections to publish a copy to Notion.'};
    }

    const token = deps.token ?? process.env.NOTION_TOKEN;
    const parentPageId = notionId(deps.parentPageId ?? process.env.NOTION_PARENT_PAGE_ID);
    if (!token || !parentPageId) {
      return {status: 'skipped', url: null, message: 'Notion is not configured to host a Life Blueprint page on the server.'};
    }

    const storedPageId = deps.storedPageId !== undefined ? deps.storedPageId : await getBlueprintNotionPageId(userId);
    const persist = deps.persistPageId ?? ((id: string) => setBlueprintNotionPageId(userId, id));

    const {pageId, url} = storedPageId
      ? await updateBlueprintPage(token, storedPageId, blueprint, opts)
      : await createBlueprintPage(token, parentPageId, blueprint, opts);
    if (!storedPageId) await persist(pageId);
    return {status: 'published', url, message: 'Life Blueprint published to Notion.'};
  } catch (e) {
    const storedPageId = deps.storedPageId ?? null;
    const message = e instanceof NotionWriteError ? e.message : 'Could not publish Life Blueprint to Notion.';
    let url: string | null = null;
    try {
      const id = storedPageId ?? (await getBlueprintNotionPageId(userId));
      if (id) url = notionPagePublicUrl(id);
    } catch {
      url = storedPageId ? notionPagePublicUrl(storedPageId) : null;
    }
    return {status: 'failed', url, message};
  }
}

type RestoreDeps = FetchOptions & {
  token?: string;
  parentPageId?: string;
  storedPageId?: string | null;
  persistPageId?: (pageId: string) => Promise<void>;
};

async function pageTitle(token: string, pageId: string, opts: FetchOptions) {
  const page = await call('notion.blueprint.read', `${API}/pages/${pageId}`, {headers: headers(token)}, opts);
  return pageTitleFromProps(page?.properties ?? {});
}

async function findLifeBlueprintPageId(token: string, parentPageId: string | undefined, storedPageId: string | null, opts: FetchOptions) {
  if (storedPageId) {
    try {
      const title = await pageTitle(token, storedPageId, opts);
      if (normLabel(title) === normLabel(PAGE_TITLE)) return storedPageId;
    } catch {
      // Page id from a previous environment may be stale; search instead.
    }
  }
  if (parentPageId) {
    const children = await listBlockChildren(token, parentPageId, opts);
    const child = children.find((b) => b.type === 'child_page' && normLabel(b.child_page?.title ?? '') === normLabel(PAGE_TITLE));
    if (typeof child?.id === 'string') return child.id;
  }
  const search = await call(
    'notion.blueprint.search',
    `${API}/search`,
    {method: 'POST', headers: headers(token), body: JSON.stringify({query: PAGE_TITLE, filter: {property: 'object', value: 'page'}, page_size: 20})},
    opts
  );
  for (const result of search?.results ?? []) {
    if (result?.object === 'page' && typeof result.id === 'string' && normLabel(pageTitleFromProps(result.properties ?? {})) === normLabel(PAGE_TITLE)) {
      return result.id as string;
    }
  }
  return null;
}

/**
 * When Postgres has no Life Blueprint (fresh Railway DB), copy the Notion page
 * titled "Life Blueprint" back into blueprint_versions and remember its page id.
 */
export async function restoreLifeBlueprintFromNotion(userId: string, deps: RestoreDeps = {}) {
  const current = await latestBlueprint(userId);
  if (current && blueprintHasContent(parseBlueprint(current.data))) return {status: 'skipped' as const, pageId: null};
  const token = deps.token ?? process.env.NOTION_TOKEN;
  const parentPageId = notionId(deps.parentPageId ?? process.env.NOTION_PARENT_PAGE_ID);
  if (!token) return {status: 'skipped' as const, pageId: null};

  const opts: FetchOptions = {timeoutMs: 60_000, ...deps};
  try {
    const storedPageId = deps.storedPageId !== undefined ? deps.storedPageId : await getBlueprintNotionPageId(userId);
    const pageId = await findLifeBlueprintPageId(token, parentPageId, storedPageId ?? null, opts);
    if (!pageId) return {status: 'skipped' as const, pageId: null};

    const persist = deps.persistPageId ?? ((id: string) => setBlueprintNotionPageId(userId, id));
    if (pageId !== storedPageId) await persist(pageId);

    const blocks = await listBlockChildren(token, pageId, opts);
    const data = parseBlueprintFromNotionBlocks(blocks);
    if (!blueprintHasContent(data)) return {status: 'skipped' as const, pageId};
    const saved = await saveBlueprint(userId, data, current?.version ?? 0);
    if (!saved) return {status: 'skipped' as const, pageId};
    return {status: 'restored' as const, pageId};
  } catch (e) {
    logEvent('warn', 'blueprint.restore.notion', {kind: e instanceof Error ? e.name : 'unknown'});
    return {status: 'failed' as const, pageId: null};
  }
}
