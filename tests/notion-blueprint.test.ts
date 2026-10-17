import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {emptyBlueprint} from '@/lib/blueprint';
import {publishLifeBlueprintToNotion, blueprintNotionBlocks, parseBlueprintFromNotionBlocks, restoreLifeBlueprintFromNotion} from '@/lib/notion-blueprint';
import {latestBlueprint, NOTION_WRITE, saveBlueprint, setPermission} from '@/lib/intake-store';
import {getBlueprintNotionPageId} from '@/lib/store';
import {freshDb, getUser, json, mockFetch} from './helpers';

const PARENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PAGE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function titleProps(t: string) {
  return {title: {type: 'title', title: [{plain_text: t}]}};
}

function headingBlock(text: string) {
  return {object: 'block', id: `h-${text}`, type: 'heading_2', heading_2: {rich_text: [{plain_text: text}]}};
}

describe('Life Blueprint Notion publish', () => {
  beforeEach(async () => {
    await freshDb();
    vi.stubEnv('NOTION_TOKEN', 'secret');
    vi.stubEnv('NOTION_PARENT_PAGE_ID', PARENT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds heading and bullet blocks from confirmed fields only', () => {
    const bp = emptyBlueprint();
    bp.goals = ['Ship v1'];
    const blocks = blueprintNotionBlocks(bp);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({type: 'heading_2'});
    expect(blocks[1]).toMatchObject({type: 'bulleted_list_item'});
  });

  it('skips Notion when task writes are off', async () => {
    const user = await getUser();
    const bp = emptyBlueprint();
    bp.goals = ['A goal'];
    const r = await publishLifeBlueprintToNotion(user.id, bp);
    expect(r.status).toBe('skipped');
    expect(await getBlueprintNotionPageId(user.id)).toBeNull();
  });

  it('creates a page on first publish and reuses the id on update', async () => {
    const user = await getUser();
    await setPermission(user.id, NOTION_WRITE, 'granted');
    await saveBlueprint(user.id, emptyBlueprint(), 0);

    const bp1 = emptyBlueprint();
    bp1.goals = ['First goal'];

    const {impl, calls} = mockFetch([
      [
        '/v1/pages',
        (url, init) => {
          if (init.method === 'POST') {
            return json({object: 'page', id: PAGE, url: `https://www.notion.so/${PAGE}`, properties: titleProps('Life Blueprint')});
          }
          return json({object: 'page', id: PAGE, url: `https://www.notion.so/${PAGE}`, properties: titleProps('Life Blueprint')});
        }
      ],
      ['/v1/blocks', (url, init) => {
        if (url.pathname.includes('/children') && init.method === 'PATCH') return json({results: []});
        if (url.pathname.includes('/children')) {
          return json({results: [headingBlock('Long-term goals')], has_more: false});
        }
        if (init.method === 'PATCH') return json({object: 'block', id: 'old'});
        return json({results: [], has_more: false});
      }]
    ]);

    const first = await publishLifeBlueprintToNotion(user.id, bp1, {fetchImpl: impl});
    expect(first.status).toBe('published');
    expect(await getBlueprintNotionPageId(user.id)).toBe(PAGE);
    const createBody = JSON.parse(String(calls.find((c) => c.init.method === 'POST' && c.url.includes('/v1/pages'))?.init.body));
    expect(createBody.parent).toEqual({type: 'page_id', page_id: PARENT});

    const bp2 = emptyBlueprint();
    bp2.goals = ['Updated goal'];
    const second = await publishLifeBlueprintToNotion(user.id, bp2, {fetchImpl: impl});
    expect(second.status).toBe('published');
    expect(calls.filter((c) => c.init.method === 'POST' && c.url.includes('/v1/pages'))).toHaveLength(1);
  });
});

function bulletBlock(text: string) {
  return {object: 'block', id: `b-${text}`, type: 'bulleted_list_item', bulleted_list_item: {rich_text: [{plain_text: text}]}};
}

describe('Life Blueprint restore from Notion', () => {
  beforeEach(async () => {
    await freshDb();
    vi.stubEnv('NOTION_TOKEN', 'secret');
    vi.stubEnv('NOTION_PARENT_PAGE_ID', PARENT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses heading_2 sections and bullets back into Blueprint fields', () => {
    const data = parseBlueprintFromNotionBlocks([
      headingBlock('Long-term goals'),
      bulletBlock('Ship v1'),
      headingBlock('This quarter’s priorities'),
      bulletBlock('Finish Railway deploy')
    ]);
    expect(data.goals).toEqual(['Ship v1']);
    expect(data.quarterlyPriorities).toEqual(['Finish Railway deploy']);
  });

  it('copies the Notion page into Postgres when the local Blueprint is empty', async () => {
    const user = await getUser();
    const {impl} = mockFetch([
      [
        '/v1/blocks',
        (url) => {
          if (url.pathname.includes(PARENT) && url.pathname.includes('/children')) {
            return json({results: [{id: PAGE, type: 'child_page', child_page: {title: 'Life Blueprint'}}], has_more: false});
          }
          if (url.pathname.includes(PAGE) && url.pathname.includes('/children')) {
            return json({results: [headingBlock('Long-term goals'), bulletBlock('Ship v1')], has_more: false});
          }
          return json({results: [], has_more: false});
        }
      ]
    ]);

    const result = await restoreLifeBlueprintFromNotion(user.id, {fetchImpl: impl});
    expect(result.status).toBe('restored');
    expect(await getBlueprintNotionPageId(user.id)).toBe(PAGE);
    const row = await latestBlueprint(user.id);
    expect(row?.version).toBe(1);
    expect(row?.data).toMatchObject({goals: ['Ship v1']});
  });

  it('fills an empty local Blueprint from the Notion page', async () => {
    const user = await getUser();
    await saveBlueprint(user.id, emptyBlueprint(), 0);
    const {impl} = mockFetch([
      [
        '/v1/blocks',
        (url) => {
          if (url.pathname.includes(PARENT) && url.pathname.includes('/children')) {
            return json({results: [{id: PAGE, type: 'child_page', child_page: {title: 'Life Blueprint'}}], has_more: false});
          }
          if (url.pathname.includes(PAGE) && url.pathname.includes('/children')) {
            return json({results: [headingBlock('Long-term goals'), bulletBlock('Ship v1')], has_more: false});
          }
          return json({results: [], has_more: false});
        }
      ]
    ]);
    const result = await restoreLifeBlueprintFromNotion(user.id, {fetchImpl: impl});
    expect(result.status).toBe('restored');
    expect((await latestBlueprint(user.id))?.data).toMatchObject({goals: ['Ship v1']});
  });

  it('does not overwrite a Blueprint that already exists locally', async () => {
    const user = await getUser();
    const local = emptyBlueprint();
    local.goals = ['Keep me'];
    await saveBlueprint(user.id, local, 0);
    const {impl, calls} = mockFetch([['/v1/', () => json({results: []})]]);
    const result = await restoreLifeBlueprintFromNotion(user.id, {fetchImpl: impl});
    expect(result.status).toBe('skipped');
    expect(calls).toHaveLength(0);
    expect((await latestBlueprint(user.id))?.data).toMatchObject({goals: ['Keep me']});
  });

  it('finds the Life Blueprint page as a sibling of the tasks database', async () => {
    const user = await getUser();
    vi.stubEnv('NOTION_PARENT_PAGE_ID', '');
    vi.stubEnv('NOTION_DATABASE_ID', PARENT.replace('a', 'd'));
    const databaseId = process.env.NOTION_DATABASE_ID!;
    const {impl} = mockFetch([
      [
        '/v1/databases',
        () => json({parent: {type: 'page_id', page_id: PARENT}})
      ],
      [
        '/v1/blocks',
        (url) => {
          if (url.pathname.includes(PARENT) && url.pathname.includes('/children')) {
            return json({results: [{id: PAGE, type: 'child_page', child_page: {title: 'Life Blueprint'}}], has_more: false});
          }
          if (url.pathname.includes(PAGE) && url.pathname.includes('/children')) {
            return json({results: [headingBlock('Long-term goals'), bulletBlock('Ship v1')], has_more: false});
          }
          return json({results: [], has_more: false});
        }
      ]
    ]);
    const result = await restoreLifeBlueprintFromNotion(user.id, {fetchImpl: impl, parentPageId: ''});
    expect(result.status).toBe('restored');
    expect(databaseId).toBeTruthy();
  });
});
