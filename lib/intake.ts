import {createHash} from 'node:crypto';
import {answerCosQuery, matchCosQuery} from './cos-queries';
import {defaultDeps as briefingDeps, runBriefing, type RunOutcome} from './briefing-service';
import {extractItems, type Extracted} from './intake-ai';
import {dice, planOps, type PlannedOp} from './intake-match';
import type {ExtractedItem} from './intake-schema';
import {
  addSuggestions,
  claimOp,
  getReply,
  hasPermission,
  insertAssistantMessage,
  insertUserMessage,
  NOTION_WRITE,
  opsForMessage,
  suggestionsForMessage,
  updateOp,
  type OpRow
} from './intake-store';
import {logEvent} from './log';
import {fetchNotionTasks} from './notion';
import {
  createTask,
  findByExternalKey,
  loadWriteTarget,
  mismatches,
  NotionWriteError,
  retrieveTask,
  snapshotFields,
  trashTask,
  updateTask,
  type TaskFields,
  type WriteTarget
} from './notion-write';
import {acquireLock, audit, releaseLock} from './store';
import {localDate} from './time';
import type {SourceHealth, Task} from './types';

export type ItemAction = 'created' | 'updated' | 'unchanged' | 'proposed' | 'failed' | 'ambiguous' | 'skipped' | 'undone';

export type ItemResult = {
  opId: string | null;
  action: ItemAction;
  kind: ExtractedItem['kind'];
  title: string;
  url: string | null;
  changes: string[];
  detail: string | null;
  /** The user's own words this item came from. */
  evidence: string;
  assumption: string | null;
  candidates?: {title: string; url: string}[];
};

export type NoteResult = {id: string; kind: string; text: string};

export type IntakeResult = {
  messageId: string;
  extractor: Extracted['extractor'];
  extractorNote: string | null;
  items: ItemResult[];
  notes: NoteResult[];
  clarifications: string[];
  writes: 'applied' | 'proposed' | 'failed' | 'partial' | 'none';
  briefing: RunOutcome | 'skipped' | null;
  reply: string;
};

export type IntakeDeps = {
  extract: (message: string, now: Date) => Promise<Extracted>;
  fetchTasks: () => Promise<{tasks: Task[]; health: SourceHealth}>;
  target: () => Promise<WriteTarget>;
  create: typeof createTask;
  update: typeof updateTask;
  trash: typeof trashTask;
  retrieve: typeof retrieveTask;
  findByKey: typeof findByExternalKey;
  /** Regenerates today's briefing so the Chief of Staff sees the change immediately. */
  refresh: (userId: string, changed: Task[], removed: string[], key: string, now: Date) => Promise<RunOutcome | 'skipped'>;
  now: () => Date;
};

/** Notion's query index can lag a write by a few seconds, so verified pages are merged over the fresh read. */
async function defaultRefresh(userId: string, changed: Task[], removed: string[], key: string, now: Date) {
  const result = await runBriefing(
    {userId, date: localDate(now), trigger: 'intake', idempotencyKey: key},
    {
      ...briefingDeps,
      fetchTasks: async () => {
        const read = await fetchNotionTasks();
        if (read.health.state !== 'connected') return read;
        const byId = new Map(read.tasks.map((t) => [t.id, t]));
        for (const t of changed) byId.set(t.id, t);
        for (const id of removed) byId.delete(id);
        return {...read, tasks: [...byId.values()], health: {...read.health, count: byId.size}};
      }
    }
  );
  return result.outcome;
}

export const defaultIntakeDeps: IntakeDeps = {
  extract: (message, now) => extractItems(message, now),
  fetchTasks: () => fetchNotionTasks(),
  target: () => loadWriteTarget(),
  create: createTask,
  update: updateTask,
  trash: trashTask,
  retrieve: retrieveTask,
  findByKey: findByExternalKey,
  refresh: defaultRefresh,
  now: () => new Date()
};

const LOCK_TTL_MS = 60 * 1000;
const SUGGESTION_KIND: Partial<Record<ExtractedItem['kind'], string>> = {
  goal: 'goal',
  preference: 'preference',
  personal_context: 'personal_context',
  reflection: 'reflection',
  capacity: 'capacity',
  project: 'project',
  deadline: 'constraint'
};

export const externalKeyFor = (opKey: string) => `deevaa:${createHash('sha256').update(opKey).digest('hex').slice(0, 20)}`;

const base = (p: PlannedOp): Omit<ItemResult, 'action' | 'detail'> => ({
  opId: null,
  kind: p.item.kind,
  title: p.title,
  url: 'task' in p ? p.task.url : null,
  changes: p.changes,
  evidence: p.item.evidence,
  assumption: p.item.assumption
});

const errorMessage = (e: unknown) => (e instanceof NotionWriteError ? e.message : 'The Notion write failed.');
const errorCode = (e: unknown) => (e instanceof NotionWriteError ? e.code : 'internal');

type Executed = {result: Pick<ItemResult, 'action' | 'detail' | 'url'>; task: Task | null; stop: boolean};

/** Runs one claimed operation from its stored row only, so a retry or a later "apply" behaves the same. */
async function executeOp(op: OpRow, target: WriteTarget, deps: IntakeDeps): Promise<Executed> {
  const fields = op.fields as TaskFields;
  try {
    if (op.kind === 'create') {
      const externalKey = externalKeyFor(op.opKey);
      const existing = await deps.findByKey(target, externalKey);
      const task = existing ?? (await deps.create(target, {...fields, title: op.title, externalKey})).task;
      await updateOp(op.id, {status: 'succeeded', pageId: task.id, pageUrl: task.url, afterEditedAt: task.lastEditedAt});
      return {result: {action: 'created', detail: existing ? 'Recovered the page created by an earlier attempt.' : 'Verified by reading the page back from Notion.', url: task.url}, task, stop: false};
    }
    const {task: current} = await deps.retrieve(target, op.pageId!);
    if (!current) throw new NotionWriteError('not_found', 'The Notion task was deleted or moved to trash, so it was not updated.');
    if (!mismatches(current, fields).length) {
      await updateOp(op.id, {status: 'succeeded', pageUrl: current.url, afterEditedAt: current.lastEditedAt, before: (op.before as Record<string, unknown>) ?? {}});
      return {result: {action: 'updated', detail: 'Notion already shows these values.', url: current.url}, task: current, stop: false};
    }
    const before = snapshotFields(current, fields);
    const {task} = await deps.update(target, op.pageId!, fields);
    await updateOp(op.id, {status: 'succeeded', pageUrl: task.url, before: before as Record<string, unknown>, afterEditedAt: task.lastEditedAt});
    return {result: {action: 'updated', detail: 'Verified by reading the page back from Notion.', url: task.url}, task, stop: false};
  } catch (e) {
    await updateOp(op.id, {status: 'failed', errorCode: errorCode(e)});
    logEvent('warn', 'intake.op', {kind: op.kind, code: errorCode(e)});
    const stop = e instanceof NotionWriteError && ['forbidden', 'unauthorized', 'not_configured', 'rate_limited', 'schema'].includes(e.code);
    return {result: {action: 'failed', detail: errorMessage(e), url: op.pageUrl}, task: null, stop};
  }
}

function summarize(items: ItemResult[], notes: NoteResult[], extracted: Pick<Extracted, 'reply'> | null, writes: IntakeResult['writes']) {
  const count = (a: ItemAction) => items.filter((i) => i.action === a).length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  const created = count('created');
  const updated = count('updated');
  if (created || updated) {
    parts.push(`${[created && `created ${plural(created, 'task')}`, updated && `updated ${plural(updated, 'task')}`].filter(Boolean).join(' and ')} in Notion, each verified by reading it back.`);
  }
  const proposed = count('proposed');
  if (proposed) parts.push(`${plural(proposed, 'change')} ready but not applied, because Notion updates are turned off. Turn them on to apply.`);
  const failed = count('failed');
  if (failed) parts.push(`${plural(failed, 'change')} failed; see the details below. Nothing was assumed saved.`);
  const ambiguous = count('ambiguous');
  if (ambiguous) parts.push(`${plural(ambiguous, 'update')} matched more than one task, so nothing was changed. Tell me which one you mean.`);
  if (count('unchanged')) parts.push(`${plural(count('unchanged'), 'task')} already matched Notion.`);
  if (notes.length) parts.push(`${plural(notes.length, 'note')} saved for your Life Blueprint review; none are treated as confirmed until you approve them.`);
  if (!parts.length) return extracted?.reply ?? (writes === 'none' ? 'Nothing in that message needs a task or update.' : 'No changes were made.');
  const text = parts.join(' ');
  return text[0].toUpperCase() + text.slice(1);
}

async function storeNotes(userId: string, messageId: string, items: ExtractedItem[]): Promise<NoteResult[]> {
  const existing = await suggestionsForMessage(userId, messageId);
  const rows = existing.length
    ? existing
    : await addSuggestions(
        userId,
        messageId,
        items
          .filter((i) => SUGGESTION_KIND[i.kind] || i.kind === 'personal_context')
          .map((i) => {
            const boundary = i.kind === 'personal_context' && /\b(confidential|privacy|never|approval|permission|boundary)\b/i.test(i.evidence);
            const kind = boundary ? 'boundary' : SUGGESTION_KIND[i.kind]!;
            const text = i.due ? `${i.title} (${i.due})` : i.title;
            return {kind, text};
          })
          .filter((x) => x.kind)
      );
  return rows.map((r) => ({id: r.id, kind: r.kind, text: r.text}));
}

async function runOps(userId: string, messageId: string, claims: {planned: PlannedOp | null; op: OpRow}[], deps: IntakeDeps) {
  const results: (ItemResult | null)[] = claims.map(() => null);
  const changed: Task[] = [];
  let target: WriteTarget | null = null;
  let stopped: string | null = null;
  try {
    target = await deps.target();
  } catch (e) {
    stopped = errorMessage(e);
  }
  for (const [i, {planned, op}] of claims.entries()) {
    const shared = planned ? base(planned) : {opId: op.id, kind: 'new_task' as const, title: op.title, url: op.pageUrl, changes: [], evidence: '', assumption: null};
    if (op.status === 'succeeded' || op.status === 'undone') {
      results[i] = {...shared, opId: op.id, url: op.pageUrl ?? shared.url, action: op.status === 'undone' ? 'undone' : op.kind === 'create' ? 'created' : 'updated', detail: 'Already applied.'};
      continue;
    }
    if (stopped || !target) {
      await updateOp(op.id, {status: 'failed', errorCode: 'stopped'});
      results[i] = {...shared, opId: op.id, action: 'failed', detail: stopped ?? 'Notion is unavailable.'};
      continue;
    }
    const done = await executeOp(op, target, deps);
    if (done.task) changed.push(done.task);
    if (done.stop) stopped = done.result.detail;
    results[i] = {...shared, opId: op.id, ...done.result, url: done.result.url ?? shared.url};
  }
  return {results: results as ItemResult[], changed};
}

function writesOf(items: ItemResult[]): IntakeResult['writes'] {
  const acts = new Set(items.map((i) => i.action));
  const ok = acts.has('created') || acts.has('updated');
  if (acts.has('failed')) return ok ? 'partial' : 'failed';
  if (ok) return 'applied';
  if (acts.has('proposed')) return 'proposed';
  return 'none';
}

/** Same pipeline as chat, for a voice transcript or pasted note. */
export async function processImportedNote(input: {userId: string; message: string; clientKey: string; source?: string}, deps: IntakeDeps = defaultIntakeDeps) {
  const result = await processMessage(input, deps);
  await audit(input.userId, 'intake.import', 'ok', {source: input.source ?? 'import'});
  return result;
}

/** Chat message → extraction → Notion reconciliation → verified write → stored reply → refreshed briefing. */
export async function processMessage(input: {userId: string; message: string; clientKey: string}, deps: IntakeDeps = defaultIntakeDeps): Promise<IntakeResult> {
  const {userId, message, clientKey} = input;
  const inserted = await insertUserMessage(userId, message, clientKey);
  if (inserted.outcome === 'duplicate') {
    const reply = await getReply(userId, inserted.message.id);
    if (reply?.result) return reply.result as IntakeResult;
  }
  const messageId = inserted.message.id;
  const now = deps.now();
  const query = matchCosQuery(message);
  if (query) {
    const read = await deps.fetchTasks();
    if (read.health.state === 'connected') {
      const answered = answerCosQuery(query, read.tasks, now);
      const result: IntakeResult = {
        messageId,
        extractor: 'rules',
        extractorNote: 'Answered from Notion. Nothing was written.',
        items: [],
        notes: [],
        clarifications: answered.clarifications,
        writes: 'none',
        briefing: null,
        reply: answered.reply
      };
      await insertAssistantMessage(userId, result.reply, result, messageId);
      await audit(userId, 'intake.query', 'ok', {kind: query.kind});
      return result;
    }
  }
  const extracted = await deps.extract(message, now);
  const notes = await storeNotes(userId, messageId, extracted.items);
  const taskItems = extracted.items.filter((i) => i.kind === 'new_task' || i.kind === 'status_update');

  let items: ItemResult[] = [];
  let briefing: IntakeResult['briefing'] = null;
  const clarifications = [...extracted.clarifications];

  if (taskItems.length) {
    const read = await deps.fetchTasks();
    if (read.health.state !== 'connected') {
      items = taskItems.map((it) => ({
        opId: null,
        kind: it.kind,
        title: it.title,
        url: null,
        changes: [],
        evidence: it.evidence,
        assumption: it.assumption,
        action: 'failed',
        detail: `${read.health.message} Nothing was written, because Deevaa cannot check for existing tasks.`
      }));
    } else {
      const plan = planOps(extracted.items, read.tasks);
      const granted = await hasPermission(userId, NOTION_WRITE);
      const lock = granted ? await acquireLock(`intake:${userId}`, LOCK_TTL_MS) : null;
      try {
        const claims: {planned: PlannedOp; op: OpRow}[] = [];
        const ordered: (ItemResult | {claim: number})[] = [];
        for (const p of plan) {
          if (p.action === 'ambiguous') {
            ordered.push({
              ...base(p),
              action: 'ambiguous',
              detail: `More than one task matches: ${p.candidates.map((c) => `“${c.title}”`).join(', ')}.`,
              candidates: p.candidates.map((c) => ({title: c.title, url: c.url}))
            });
            clarifications.push(`Which task did you mean by “${p.item.target ?? p.item.title}”?`);
            continue;
          }
          if (p.action === 'skip') {
            ordered.push({...base(p), action: 'skipped', detail: p.reason});
            continue;
          }
          if (p.action === 'unchanged') {
            ordered.push({...base(p), action: 'unchanged', detail: null});
            continue;
          }
          const status = granted && lock ? 'pending' : 'proposed';
          const claim = await claimOp({
            userId,
            messageId,
            opKey: `${userId}:${clientKey}:${p.index}`,
            kind: p.action,
            title: p.title,
            fields: p.fields as Record<string, unknown>,
            pageId: p.action === 'update' ? p.task.id : null,
            status
          });
          const alreadyApplied = claim.op.status === 'succeeded' || claim.op.status === 'undone';
          if (status === 'proposed' && !alreadyApplied) {
            ordered.push({...base(p), opId: claim.op.id, action: 'proposed', detail: granted ? 'Another update was running; try again in a moment.' : 'Notion updates are off.'});
            continue;
          }
          ordered.push({claim: claims.length});
          claims.push({planned: p, op: claim.op});
        }
        const run = claims.length ? await runOps(userId, messageId, claims, deps) : {results: [], changed: []};
        items = ordered.map((o) => ('claim' in o ? run.results[o.claim] : o));
        if (run.changed.length) briefing = await deps.refresh(userId, run.changed, [], `intake:${userId}:${messageId}`, now).catch(() => 'failed' as const);
      } finally {
        if (lock) await releaseLock(`intake:${userId}`, lock);
      }
    }
  }

  const writes = writesOf(items);
  const result: IntakeResult = {
    messageId,
    extractor: extracted.extractor,
    extractorNote: extracted.note,
    items,
    notes,
    clarifications: [...new Set(clarifications)].slice(0, 3),
    writes,
    briefing,
    reply: summarize(items, notes, extracted, writes)
  };
  await insertAssistantMessage(userId, result.reply, result, messageId);
  await audit(userId, 'intake.message', writes === 'failed' ? 'error' : 'ok', {
    extractor: extracted.extractor,
    created: items.filter((i) => i.action === 'created').length,
    updated: items.filter((i) => i.action === 'updated').length,
    proposed: items.filter((i) => i.action === 'proposed').length,
    failed: items.filter((i) => i.action === 'failed').length,
    ambiguous: items.filter((i) => i.action === 'ambiguous').length,
    notes: notes.length
  });
  return result;
}

async function rewriteReply(userId: string, messageId: string, items: ItemResult[], briefing: IntakeResult['briefing']) {
  const prev = (await getReply(userId, messageId))?.result as IntakeResult | undefined;
  if (!prev) return null;
  const byOp = new Map(items.filter((i) => i.opId).map((i) => [i.opId, i]));
  const merged = prev.items.map((i) => (i.opId && byOp.has(i.opId) ? {...i, ...byOp.get(i.opId)!, evidence: i.evidence, assumption: i.assumption, changes: i.changes} : i));
  const writes = writesOf(merged);
  const result: IntakeResult = {...prev, items: merged, writes, briefing, reply: summarize(merged, prev.notes, null, writes)};
  await insertAssistantMessage(userId, result.reply, result, messageId);
  return result;
}

/** Applies changes that were proposed while Notion updates were off, after the user turns them on. */
export async function applyProposed(userId: string, messageId: string, deps: IntakeDeps = defaultIntakeDeps) {
  if (!(await hasPermission(userId, NOTION_WRITE))) return {outcome: 'forbidden' as const};
  const lock = await acquireLock(`intake:${userId}`, LOCK_TTL_MS);
  if (!lock) return {outcome: 'locked' as const};
  try {
    const ops = (await opsForMessage(userId, messageId)).filter((o) => o.status === 'proposed' || o.status === 'failed');
    if (!ops.length) return {outcome: 'nothing' as const};
    const read = await deps.fetchTasks();
    if (read.health.state !== 'connected') return {outcome: 'failed' as const, message: read.health.message};
    const claims: {planned: null; op: OpRow}[] = [];
    const skipped: ItemResult[] = [];
    for (const op of ops) {
      const ours = externalKeyFor(op.opKey);
      const dup =
        op.kind === 'create' &&
        read.tasks.find((t) => t.externalKey !== ours && t.status !== 'Done' && t.status !== 'Canceled' && dice(t.title, op.title) >= 0.75);
      if (dup) {
        await updateOp(op.id, {status: 'failed', errorCode: 'duplicate'});
        skipped.push({opId: op.id, kind: 'new_task', title: op.title, url: dup.url, changes: [], evidence: '', assumption: null, action: 'unchanged', detail: `“${dup.title}” now exists in Notion, so no duplicate was created.`});
        continue;
      }
      const claimed = await claimOp({userId, messageId, opKey: op.opKey, kind: op.kind, title: op.title, fields: op.fields, pageId: op.pageId, status: 'pending'});
      claims.push({planned: null, op: claimed.op});
    }
    const run = await runOps(userId, messageId, claims, deps);
    const briefing = run.changed.length ? await deps.refresh(userId, run.changed, [], `intake-apply:${userId}:${messageId}:${Date.now()}`, deps.now()).catch(() => 'failed' as const) : null;
    const result = await rewriteReply(userId, messageId, [...run.results, ...skipped], briefing);
    await audit(userId, 'intake.apply', run.results.some((r) => r.action === 'failed') ? 'error' : 'ok', {ops: claims.length});
    return {outcome: 'applied' as const, result};
  } finally {
    await releaseLock(`intake:${userId}`, lock);
  }
}

/** Reverts Deevaa's own changes for one message: trashes pages it created and restores fields it updated. */
export async function undoMessage(userId: string, messageId: string, deps: IntakeDeps = defaultIntakeDeps) {
  if (!(await hasPermission(userId, NOTION_WRITE))) return {outcome: 'forbidden' as const};
  const lock = await acquireLock(`intake:${userId}`, LOCK_TTL_MS);
  if (!lock) return {outcome: 'locked' as const};
  try {
    const ops = (await opsForMessage(userId, messageId)).filter((o) => o.status === 'succeeded').reverse();
    if (!ops.length) return {outcome: 'nothing' as const};
    const target = await deps.target();
    const results: ItemResult[] = [];
    const changed: Task[] = [];
    const removed: string[] = [];
    for (const op of ops) {
      const shared = {opId: op.id, kind: 'new_task' as const, title: op.title, url: op.pageUrl, changes: [], evidence: '', assumption: null};
      try {
        const {task: current} = await deps.retrieve(target, op.pageId!);
        if (!current) {
          results.push({...shared, action: 'failed', detail: 'The page is already in Notion’s trash.'});
          continue;
        }
        if (op.afterEditedAt && current.lastEditedAt !== op.afterEditedAt) {
          results.push({...shared, action: 'failed', detail: 'This task was edited in Notion after Deevaa changed it, so Deevaa left it alone. Undo it in Notion instead.'});
          continue;
        }
        if (op.kind === 'create') {
          await deps.trash(target, op.pageId!);
          removed.push(op.pageId!);
        } else {
          const {task} = await deps.update(target, op.pageId!, (op.before ?? {}) as TaskFields);
          changed.push(task);
        }
        await updateOp(op.id, {status: 'undone'});
        results.push({...shared, action: 'undone', detail: op.kind === 'create' ? 'Moved to Notion’s trash, where it can still be restored.' : 'Previous values restored and verified.'});
      } catch (e) {
        results.push({...shared, action: 'failed', detail: errorMessage(e)});
      }
    }
    const briefing =
      changed.length || removed.length ? await deps.refresh(userId, changed, removed, `intake-undo:${userId}:${messageId}:${Date.now()}`, deps.now()).catch(() => 'failed' as const) : null;
    const result = await rewriteReply(userId, messageId, results, briefing);
    await audit(userId, 'intake.undo', results.some((r) => r.action === 'failed') ? 'error' : 'ok', {ops: ops.length});
    return {outcome: 'undone' as const, results, result};
  } catch (e) {
    return {outcome: 'failed' as const, message: errorMessage(e)};
  } finally {
    await releaseLock(`intake:${userId}`, lock);
  }
}
