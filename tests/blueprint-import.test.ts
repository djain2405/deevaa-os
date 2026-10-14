import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const session = vi.hoisted(() => ({user: null as null | {id: string; email: string}}));
vi.mock('@/lib/session', () => ({getSessionUser: vi.fn(async () => session.user)}));

import {POST as importApply} from '@/app/api/blueprint/import/apply/route';
import {POST as importPreview} from '@/app/api/blueprint/import/route';
import {GET as blueprintExport} from '@/app/api/blueprint/export/route';
import {BLUEPRINT_FIELDS} from '@/lib/blueprint';
import {contentSha256, extractImportPreview, importExternalKey, previewSha256} from '@/lib/blueprint-import';
import {applyImportPreview} from '@/lib/import-apply';
import {createImportPreview, findAppliedImport, markImportApplied} from '@/lib/import-store';
import {NotionWriteError} from '@/lib/notion-write';
import {fakeNotion} from './fake-notion';
import {freshDb, getUser} from './helpers';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/blueprint-import.sample.md'), 'utf8');
const BASE = 'http://localhost:3000';
const origin = {origin: BASE, 'sec-fetch-site': 'same-origin'};

let userId: string;

beforeEach(async () => {
  await freshDb();
  userId = (await getUser()).id;
  session.user = {id: userId, email: 'owner@example.com'};
});
afterEach(() => vi.unstubAllEnvs());

describe('Life Blueprint import extraction', () => {
  it('fills all 13 Blueprint fields from the sample document', () => {
    const p = extractImportPreview(FIXTURE);
    for (const f of BLUEPRINT_FIELDS) {
      expect(p.blueprint[f.key].length, f.key).toBeGreaterThan(0);
    }
    expect(p.counts.blueprintFields).toBe(13);
  });

  it('creates active, waiting, done and idea tasks without turning goals into tasks', () => {
    const p = extractImportPreview(FIXTURE);
    expect(p.tasks.some((t) => t.bucket === 'active' && /doctor/i.test(t.title))).toBe(true);
    expect(p.tasks.some((t) => t.bucket === 'waiting')).toBe(true);
    expect(p.tasks.some((t) => t.status === 'Done')).toBe(true);
    expect(p.tasks.some((t) => t.bucket === 'idea')).toBe(true);
    expect(p.tasks.some((t) => /secure romantic/i.test(t.title))).toBe(false);
    expect(p.blueprint.goals.some((g) => /romantic|partnership/i.test(g))).toBe(true);
  });

  it('leaves uncertain deadlines without inventing dates', () => {
    const p = extractImportPreview(FIXTURE);
    const citation = p.tasks.find((t) => /citation/i.test(t.title));
    expect(citation?.due).toBeNull();
    expect(p.uncertain.some((u) => /citation|deadline/i.test(u.text))).toBe(true);
  });

  it('does not put sensitive therapy wording into task titles', () => {
    const p = extractImportPreview(FIXTURE);
    expect(p.tasks.every((t) => !/therapy session|attachment patterns/i.test(t.title))).toBe(true);
  });
});

describe('import apply to Notion', () => {
  it('creates and verifies tasks on an empty workspace', async () => {
    const notion = fakeNotion();
    const preview = extractImportPreview(FIXTURE);
    const hash = previewSha256(preview);
    const r = await applyImportPreview(userId, preview, hash, {
      ...notion.deps,
      skipBriefing: true
    });
    expect(r.outcome).toBe('applied');
    expect(r.items.filter((i) => i.action === 'created').length).toBeGreaterThan(0);
    expect(notion.pages.size).toBeGreaterThan(0);
  });

  it('records applied imports by content hash for duplicate detection', async () => {
    const hash = contentSha256(FIXTURE);
    const preview = extractImportPreview(FIXTURE);
    const created = await createImportPreview({userId, sourceName: 'x.md', contentSha256: hash, previewSha256: previewSha256(preview), preview});
    await markImportApplied(userId, created.id, {outcome: 'applied'});
    const dup = await findAppliedImport(userId, hash);
    expect(dup?.status).toBe('applied');
  });

  it('stops after forbidden writes and reports partial failure', async () => {
    const notion = fakeNotion();
    notion.failures.create = new NotionWriteError('forbidden', 'forbidden');
    const preview = extractImportPreview(FIXTURE);
    const hash = previewSha256(preview);
    const r = await applyImportPreview(userId, preview, hash, {...notion.deps, skipBriefing: true});
    expect(['failed', 'partial']).toContain(r.outcome);
    expect(r.items.some((i) => i.action === 'failed')).toBe(true);
  });

  it('rejects a stale preview hash', async () => {
    const preview = extractImportPreview(FIXTURE);
    const r = await applyImportPreview(userId, preview, 'deadbeef'.repeat(8));
    expect(r.outcome).toBe('stale');
  });
});

describe('import API security', () => {
  it('rejects unauthenticated preview and apply', async () => {
    session.user = null;
    expect((await importPreview(new Request(`${BASE}/api/blueprint/import`, {method: 'POST', headers: origin, body: JSON.stringify({markdown: FIXTURE})}))).status).toBe(401);
    expect((await importApply(new Request(`${BASE}/api/blueprint/import/apply`, {method: 'POST', headers: origin, body: '{}'}))).status).toBe(401);
    expect((await blueprintExport()).status).toBe(401);
  });

  it('rejects cross-origin import apply', async () => {
    session.user = {id: userId, email: 'owner@example.com'};
    const res = await importApply(new Request(`${BASE}/api/blueprint/import/apply`, {method: 'POST', headers: {origin: 'https://evil.example'}, body: '{}'}));
    expect(res.status).toBe(403);
  });
});

describe('stable import keys', () => {
  it('uses deterministic external keys per user and title', () => {
    const a = importExternalKey(userId, 'Review citation', 'Personal');
    const b = importExternalKey(userId, 'Review citation', 'Personal');
    expect(a).toBe(b);
    expect(a.startsWith('deevaa:imp:')).toBe(true);
  });
});
