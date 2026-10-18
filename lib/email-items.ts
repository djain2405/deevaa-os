import {and, eq} from 'drizzle-orm';
import {getDb} from './db/client';
import {emailItems} from './db/schema';
import {hasPermission, NOTION_WRITE} from './intake-store';
import {logEvent} from './log';
import {createTask, findByExternalKey, loadWriteTarget} from './notion-write';
import {audit, getBriefing} from './store';
import {localDate} from './time';
import {BRIEFING_VERSION, type BriefingSnapshot, type EmailAction, type EmailSummary} from './types';

export type EmailItemRow = typeof emailItems.$inferSelect;
export type EmailItemKind = 'hidden' | 'saved';

const GMAIL_LINK = /^https:\/\/mail\.google\.com\/mail\//;

export function threadIdFromPermalink(permalink: string) {
  const hash = permalink.split('#')[1] ?? '';
  const id = hash.replace(/^inbox\//, '').split('/')[0];
  return id || null;
}

export function gmailExternalKey(permalink: string) {
  const thread = threadIdFromPermalink(permalink);
  return thread ? `deevaa:gmail:${thread}` : null;
}

export async function listEmailItems(userId: string) {
  const db = await getDb();
  return db.select().from(emailItems).where(eq(emailItems.userId, userId));
}

export async function getEmailItem(userId: string, permalink: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(emailItems)
    .where(and(eq(emailItems.userId, userId), eq(emailItems.permalink, permalink)));
  return row ?? null;
}

async function upsertEmailItem(input: {
  userId: string;
  permalink: string;
  kind: EmailItemKind;
  title?: string | null;
  pageId?: string | null;
  pageUrl?: string | null;
}) {
  const db = await getDb();
  const now = new Date();
  const [row] = await db
    .insert(emailItems)
    .values({
      userId: input.userId,
      permalink: input.permalink,
      kind: input.kind,
      title: input.title ?? null,
      pageId: input.pageId ?? null,
      pageUrl: input.pageUrl ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [emailItems.userId, emailItems.permalink],
      set: {
        kind: input.kind,
        title: input.title ?? null,
        pageId: input.pageId ?? null,
        pageUrl: input.pageUrl ?? null,
        updatedAt: now
      }
    })
    .returning();
  return row;
}

function digestItem(snapshot: BriefingSnapshot | null, permalink: string): (EmailAction & {kind: 'action'}) | (EmailSummary & {kind: 'summary'}) | null {
  const digest = snapshot?.emailDigest;
  if (!digest) return null;
  const action = digest.actions.find((a) => a.permalink === permalink);
  if (action) return {...action, kind: 'action'};
  const summary = digest.summaries.find((s) => s.permalink === permalink);
  if (summary) return {...summary, kind: 'summary'};
  return null;
}

export async function hideEmailItem(userId: string, permalink: string) {
  if (!GMAIL_LINK.test(permalink)) throw Object.assign(new Error('bad_permalink'), {code: 'bad_permalink'});
  const row = await getBriefing(userId, localDate(), BRIEFING_VERSION);
  const item = digestItem((row?.snapshot as BriefingSnapshot | undefined) ?? null, permalink);
  if (!item) throw Object.assign(new Error('not_in_digest'), {code: 'not_in_digest'});
  const saved = await upsertEmailItem({
    userId,
    permalink,
    kind: 'hidden',
    title: item.kind === 'action' ? item.title : item.subject
  });
  await audit(userId, 'gmail.item.hide', 'ok');
  return saved;
}

export type SaveEmailDeps = {
  hasPermission?: typeof hasPermission;
  loadWriteTarget?: typeof loadWriteTarget;
  findByExternalKey?: typeof findByExternalKey;
  createTask?: typeof createTask;
};

export async function saveEmailItemToNotion(userId: string, permalink: string, deps: SaveEmailDeps = {}) {
  if (!GMAIL_LINK.test(permalink)) throw Object.assign(new Error('bad_permalink'), {code: 'bad_permalink'});
  const row = await getBriefing(userId, localDate(), BRIEFING_VERSION);
  const item = digestItem((row?.snapshot as BriefingSnapshot | undefined) ?? null, permalink);
  if (!item) throw Object.assign(new Error('not_in_digest'), {code: 'not_in_digest'});
  const permitted = deps.hasPermission ?? hasPermission;
  if (!(await permitted(userId, NOTION_WRITE))) {
    throw Object.assign(new Error('writes_off'), {code: 'writes_off'});
  }
  const key = gmailExternalKey(permalink);
  if (!key) throw Object.assign(new Error('bad_permalink'), {code: 'bad_permalink'});
  const title = item.kind === 'action' ? item.title : item.subject;
  const due = item.kind === 'action' ? item.due : null;
  const load = deps.loadWriteTarget ?? loadWriteTarget;
  const lookup = deps.findByExternalKey ?? findByExternalKey;
  const create = deps.createTask ?? createTask;
  try {
    const target = await load();
    const existing = await lookup(target, key);
    if (existing) {
      const saved = await upsertEmailItem({userId, permalink, kind: 'saved', title, pageId: existing.id, pageUrl: existing.url});
      await audit(userId, 'gmail.item.save', 'ok', {duplicate: true});
      return {item: saved, task: existing, created: false};
    }
    const {task} = await create(target, {
      title,
      status: 'Ready',
      due,
      sourceLink: permalink,
      externalKey: key,
      nextAction: item.why
    });
    const saved = await upsertEmailItem({userId, permalink, kind: 'saved', title, pageId: task.id, pageUrl: task.url});
    await audit(userId, 'gmail.item.save', 'ok');
    return {item: saved, task, created: true};
  } catch (e) {
    logEvent('error', 'gmail.item.save', {kind: e instanceof Error ? e.name : 'unknown'});
    throw e;
  }
}
