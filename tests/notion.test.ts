import {describe, expect, it} from 'vitest';
import {dedupeTasks, fetchNotionTasks, mapPage, normalizePriority, normalizeStatus, notionId, NOTION_VERSION} from '@/lib/notion';
import {createTasksDatabase} from '@/lib/notion-setup';
import {json, mockFetch, task} from './helpers';

const cfg = {token: 'secret_notion_token_value', dataSourceId: 'ds-1'};
const fast = {retryDelayMs: 0};

const schema = {
  properties: {
    Name: {id: 'title', type: 'title'},
    Status: {id: 's', type: 'select'},
    Priority: {id: 'p', type: 'select'},
    Due: {id: 'd', type: 'date'},
    Duration: {id: 'du', type: 'number'},
    Context: {id: 'c', type: 'select'},
    Energy: {id: 'e', type: 'select'},
    Blocker: {id: 'b', type: 'rich_text'},
    ExternalKey: {id: 'x', type: 'rich_text'},
    SourceLink: {id: 'l', type: 'url'}
  }
};

function page(id: string, props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    object: 'page',
    id,
    url: `https://www.notion.so/${id}`,
    last_edited_time: '2026-10-10T00:00:00.000Z',
    properties: {
      Name: {type: 'title', title: [{plain_text: `Title ${id}`}]},
      Status: {type: 'select', select: {name: 'Ready'}},
      ...props
    },
    ...extra
  };
}

describe('Notion data source reads', () => {
  it('uses the 2025-09-03 data source API and follows pagination cursors', async () => {
    const {impl, calls} = mockFetch([
      ['/data_sources/ds-1/query', (_u, init) => {
        const body = JSON.parse(String(init.body));
        return body.start_cursor === 'cursor-2'
          ? json({results: [page('p3')], has_more: false, next_cursor: null})
          : json({results: [page('p1'), page('p2')], has_more: true, next_cursor: 'cursor-2'});
      }],
      ['/data_sources/ds-1', () => json(schema)]
    ]);
    const {tasks, health} = await fetchNotionTasks(cfg, {fetchImpl: impl, ...fast});
    expect(tasks.map((t) => t.id)).toEqual(['p1', 'p2', 'p3']);
    expect(health.state).toBe('connected');
    expect(health.lastSyncedAt).not.toBeNull();
    expect(tasks.every((t) => t.source === 'notion')).toBe(true);
    const queries = calls.filter((c) => c.url.endsWith('/query'));
    expect(queries).toHaveLength(2);
    expect((queries[0].init.headers as Record<string, string>)['Notion-Version']).toBe(NOTION_VERSION);
    expect(calls.some((c) => c.url.includes('/databases/'))).toBe(false);
  });

  it('resolves a database id to its first data source', async () => {
    const {impl, calls} = mockFetch([
      ['/databases/db-1', () => json({data_sources: [{id: 'ds-9', name: 'Tasks'}]})],
      ['/data_sources/ds-9/query', () => json({results: [], has_more: false})],
      ['/data_sources/ds-9', () => json(schema)]
    ]);
    const {health} = await fetchNotionTasks({token: 't', databaseId: 'db-1'}, {fetchImpl: impl, ...fast});
    expect(health.state).toBe('connected');
    expect(calls[0].url).toContain('/v1/databases/db-1');
  });

  it('reports not_connected without inventing demo tasks', async () => {
    const {tasks, health} = await fetchNotionTasks({}, {});
    expect(tasks).toEqual([]);
    expect(health.state).toBe('not_connected');
  });

  it('returns an error and no tasks when the token is revoked', async () => {
    const {impl} = mockFetch([['/data_sources/ds-1', () => json({object: 'error', code: 'unauthorized', message: 'API token is invalid. secret_xyz'}, 401)]]);
    const {tasks, health} = await fetchNotionTasks(cfg, {fetchImpl: impl, ...fast});
    expect(tasks).toEqual([]);
    expect(health.state).toBe('error');
    expect(health.message).toMatch(/revoked/);
    expect(health.message).not.toContain('secret_xyz');
  });

  it('retries transient failures, then surfaces a generic error', async () => {
    let attempts = 0;
    const {impl} = mockFetch([['/data_sources/ds-1', () => (attempts++, json({message: 'internal detail'}, 503))]]);
    const {health} = await fetchNotionTasks(cfg, {fetchImpl: impl, ...fast});
    expect(attempts).toBe(3);
    expect(health.state).toBe('error');
    expect(health.message).not.toContain('internal detail');
  });

  it('fails clearly when the minimum schema is missing', async () => {
    const {impl} = mockFetch([['/data_sources/ds-1', () => json({properties: {Name: {id: 't', type: 'title'}}})]]);
    const {health} = await fetchNotionTasks(cfg, {fetchImpl: impl, ...fast});
    expect(health.state).toBe('error');
    expect(health.message).toMatch(/Status/);
  });

  it('warns about missing optional properties instead of failing', async () => {
    const {impl} = mockFetch([
      ['/query', () => json({results: [page('p1')], has_more: false})],
      ['/data_sources/ds-1', () => json({properties: {Task: {id: 't', type: 'title'}, Status: {id: 's', type: 'status'}}})]
    ]);
    const {tasks, health} = await fetchNotionTasks(cfg, {fetchImpl: impl, ...fast});
    expect(health.state).toBe('connected');
    expect(health.warnings.join(' ')).toMatch(/Duration/);
    expect(tasks[0].duration).toBeNull();
  });
});

describe('Notion record mapping', () => {
  it('normalizes statuses, including Notion status-type defaults', () => {
    expect(normalizeStatus('Ready')).toBe('Ready');
    expect(normalizeStatus('Not started')).toBe('Ready');
    expect(normalizeStatus('In progress')).toBe('In Progress');
    expect(normalizeStatus('Complete')).toBe('Done');
    expect(normalizeStatus('Cancelled')).toBe('Canceled');
    expect(normalizeStatus('Waiting for User')).toBe('Waiting for User');
    expect(normalizeStatus('')).toBe('Inbox');
    expect(normalizeStatus('Someday maybe')).toBe('Needs Verification');
  });

  it('normalizes priority labels', () => {
    expect(normalizePriority('P0')).toBe('Urgent');
    expect(normalizePriority('high')).toBe('High');
    expect(normalizePriority(undefined)).toBe('None');
  });

  it('maps due dates, durations, blockers, dependencies and links', () => {
    const t = mapPage(
      page('p1', {
        Status: {type: 'status', status: {name: 'In progress'}},
        Priority: {type: 'select', select: {name: 'High'}},
        Due: {type: 'date', date: {start: '2026-10-15'}},
        Duration: {type: 'number', number: 20},
        Context: {type: 'select', select: {name: 'phone'}},
        Energy: {type: 'select', select: {name: 'Low'}},
        Blocker: {type: 'rich_text', rich_text: [{plain_text: 'Need reply'}]},
        'Blocked By': {type: 'relation', relation: [{id: 'p0'}]},
        SourceLink: {type: 'url', url: 'https://github.com/org/repo/pull/1'}
      })
    )!;
    expect(t).toMatchObject({status: 'In Progress', priority: 'High', due: '2026-10-15', duration: 20, context: 'Phone', energy: 'Low', blocker: 'Need reply', blockedBy: ['p0']});
    expect(t.sourceLink).toBe('https://github.com/org/repo/pull/1');
  });

  it('never invents a duration', () => {
    expect(mapPage(page('p1'))!.duration).toBeNull();
    expect(mapPage(page('p2', {Duration: {type: 'number', number: 0}}))!.duration).toBeNull();
  });

  it('skips archived and trashed pages', () => {
    expect(mapPage(page('p1', {}, {in_trash: true}))).toBeNull();
    expect(mapPage(page('p2', {}, {archived: true}))).toBeNull();
  });

  it('deduplicates by page id and then by ExternalKey, keeping the newest edit', () => {
    const a = task({id: 'same', title: 'old'});
    const b = task({id: 'same', title: 'new'});
    const k1 = task({id: 'k1', externalKey: 'gh-1', lastEditedAt: '2026-10-01T00:00:00Z'});
    const k2 = task({id: 'k2', externalKey: 'gh-1', lastEditedAt: '2026-10-05T00:00:00Z'});
    const out = dedupeTasks([a, b, k1, k2]);
    expect(out.map((t) => t.id).sort()).toEqual(['k2', 'same']);
    expect(out.find((t) => t.id === 'same')!.title).toBe('new');
  });
});

describe('Notion setup script', () => {
  it('creates the database with initial_data_source and a data-source relation', async () => {
    const {impl, calls} = mockFetch([
      ['/v1/databases', () => json({id: 'db-new', data_sources: [{id: 'ds-new'}]})],
      ['/v1/data_sources/ds-new', () => json({})]
    ]);
    const r = await createTasksDatabase('t', 'parent-page', {fetchImpl: impl, retryDelayMs: 0});
    expect(r).toEqual({databaseId: 'db-new', dataSourceId: 'ds-new', relationAdded: true});
    const create = JSON.parse(String(calls[0].init.body));
    expect(create.parent).toEqual({type: 'page_id', page_id: 'parent-page'});
    expect(Object.keys(create.initial_data_source.properties)).toEqual(expect.arrayContaining(['Name', 'Status', 'Duration', 'Due', 'Priority']));
    const patch = JSON.parse(String(calls[1].init.body));
    expect(patch.properties['Blocked By'].relation).toEqual({data_source_id: 'ds-new', type: 'single_property', single_property: {}});
  });

  it('accepts copied Notion links as ids', () => {
    const id = '1a2b3c4d5e6f40718293a4b5c6d7e8f9';
    const dashed = '1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9';
    expect(notionId(id)).toBe(dashed);
    expect(notionId(` ${dashed.toUpperCase()} `)).toBe(dashed);
    expect(notionId(`https://www.notion.so/Deevaa-${id}`)).toBe(dashed);
    expect(notionId(`https://www.notion.so/team/Cafe-Deevaa-${id}?v=ffffffffffffffffffffffffffffffff&pvs=4`)).toBe(dashed);
    expect(notionId(`https://www.notion.so/${id}#abcdefabcdefabcdefabcdefabcdefab`)).toBe(dashed);
    expect(notionId('')).toBeUndefined();
    expect(notionId('not-an-id')).toBe('not-an-id');
  });
});
