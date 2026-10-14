import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {emptyBlueprint} from '@/lib/blueprint';
import {publishLifeBlueprintToNotion, blueprintNotionBlocks} from '@/lib/notion-blueprint';
import {NOTION_WRITE, setPermission} from '@/lib/intake-store';
import {saveBlueprint} from '@/lib/intake-store';
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
