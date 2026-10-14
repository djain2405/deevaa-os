import {parseBlueprint, type Blueprint} from './blueprint';
import {type ImportPreview, type ImportTask, importExternalKey, previewSha256} from './blueprint-import';
import {runBriefing} from './briefing-service';
import {latestBlueprint, saveBlueprint} from './intake-store';
import {dice} from './intake-match';
import {localDate} from './time';
import {NotionWriteError, type TaskFields, type WriteTarget, createTask, loadWriteTarget, updateTask, findByExternalKey, retrieveTask} from './notion-write';
import {fetchNotionTasks} from './notion';
import type {Task} from './types';

export type ImportItemResult = {
  taskId: string;
  title: string;
  action: 'created' | 'updated' | 'unchanged' | 'failed' | 'skipped';
  url: string | null;
  detail: string;
};

export type ImportApplyResult = {
  outcome: 'applied' | 'duplicate' | 'stale' | 'failed' | 'partial';
  blueprintVersion: number | null;
  items: ImportItemResult[];
  counts: ImportPreview['counts'];
  message: string;
  briefing: unknown;
};

const DUPLICATE = 0.75;
const STOP = new Set(['forbidden', 'unauthorized', 'not_configured', 'rate_limited', 'schema']);

function fieldsFromTask(t: ImportTask, externalKey: string): TaskFields & {title: string} {
  return {
    title: t.title,
    status: t.status,
    priority: t.priority && t.priority !== 'None' ? t.priority : null,
    due: t.due,
    project: t.project,
    nextAction: t.nextAction,
    duration: t.duration,
    externalKey
  };
}

function mergeBlueprint(existing: Blueprint | null, incoming: Blueprint): Blueprint {
  const base = existing ?? parseBlueprint(null);
  const out = parseBlueprint(base);
  for (const key of Object.keys(incoming) as (keyof Blueprint)[]) {
    for (const line of incoming[key]) {
      if (!out[key].includes(line) && out[key].length < 30) out[key].push(line);
    }
  }
  return out;
}

function matchTask(t: ImportTask, tasks: Task[], userId: string) {
  const key = importExternalKey(userId, t.title, t.project);
  const byKey = tasks.find((x) => x.externalKey === key);
  if (byKey) return byKey;
  const hit = tasks
    .map((task) => ({task, score: dice(t.title, task.title)}))
    .filter((h) => h.score >= DUPLICATE)
    .sort((a, b) => b.score - a.score)[0];
  return hit?.task ?? null;
}

type ApplyDeps = {
  now?: () => Date;
  target?: () => Promise<WriteTarget>;
  fetchTasks?: typeof fetchNotionTasks;
  create?: (target: WriteTarget, fields: TaskFields & {title: string}) => Promise<{task: Task}>;
  update?: (target: WriteTarget, id: string, fields: TaskFields) => Promise<{task: Task}>;
  findByKey?: (target: WriteTarget, key: string) => Promise<Task | null>;
  retrieve?: (target: WriteTarget, id: string) => Promise<{task: Task | null; trashed: boolean}>;
  skipBriefing?: boolean;
};

export async function applyImportPreview(
  userId: string,
  preview: ImportPreview,
  expectedPreviewHash: string,
  opts: ApplyDeps = {}
): Promise<ImportApplyResult> {
  const hash = previewSha256(preview);
  if (hash !== expectedPreviewHash) {
    return {outcome: 'stale', blueprintVersion: null, items: [], counts: preview.counts, message: 'The preview changed. Reload and approve again.', briefing: null};
  }

  const now = opts.now ?? (() => new Date());
  const current = await latestBlueprint(userId);
  const merged = mergeBlueprint(current ? parseBlueprint(current.data) : null, preview.blueprint);
  const saved = await saveBlueprint(userId, merged, current?.version ?? 0);
  if (!saved) {
    return {outcome: 'stale', blueprintVersion: null, items: [], counts: preview.counts, message: 'The Blueprint changed while you were reviewing. Reload and try again.', briefing: null};
  }

  let target: WriteTarget;
  try {
    target = opts.target ? await opts.target() : await loadWriteTarget();
  } catch (e) {
    return {
      outcome: 'failed',
      blueprintVersion: saved.version,
      items: [],
      counts: preview.counts,
      message: e instanceof NotionWriteError ? e.message : 'Notion is not ready for writes.',
      briefing: null
    };
  }

  const read = await (opts.fetchTasks ?? fetchNotionTasks)();
  const tasks = read.tasks;
  const createFn = opts.create ?? createTask;
  const updateFn = opts.update ?? updateTask;
  const findKey = opts.findByKey ?? findByExternalKey;
  const retrieveFn = opts.retrieve ?? retrieveTask;
  const items: ImportItemResult[] = [];
  let stopped = false;

  for (const t of preview.tasks) {
    if (stopped) {
      items.push({taskId: t.id, title: t.title, action: 'failed', url: null, detail: 'Skipped because an earlier write failed.'});
      continue;
    }
    const externalKey = importExternalKey(userId, t.title, t.project);
    const fields = fieldsFromTask(t, externalKey);
    try {
      const existingByKey = await findKey(target, externalKey);
      const existing = existingByKey ?? matchTask(t, tasks, userId);
      if (existing) {
        const {task: currentTask} = await retrieveFn(target, existing.id);
        if (!currentTask) throw new NotionWriteError('not_found', 'Task missing in Notion.');
        const patch: TaskFields = {};
        if (fields.status && fields.status !== currentTask.status) patch.status = fields.status;
        if (fields.due !== undefined && fields.due !== currentTask.due?.slice(0, 10)) patch.due = fields.due;
        if (fields.priority && fields.priority !== currentTask.priority) patch.priority = fields.priority;
        if (fields.project && fields.project !== currentTask.project) patch.project = fields.project;
        if (fields.nextAction && fields.nextAction !== currentTask.nextAction) patch.nextAction = fields.nextAction;
        if (!Object.keys(patch).length) {
          items.push({taskId: t.id, title: t.title, action: 'unchanged', url: currentTask.url, detail: 'Already matched Notion.'});
          continue;
        }
        const {task: updated} = await updateFn(target, existing.id, patch);
        items.push({taskId: t.id, title: t.title, action: 'updated', url: updated.url, detail: 'Verified in Notion.'});
        continue;
      }
      const {task: created} = await createFn(target, fields);
      items.push({taskId: t.id, title: t.title, action: 'created', url: created.url, detail: 'Verified in Notion.'});
    } catch (e) {
      const code = e instanceof NotionWriteError ? e.code : 'internal';
      items.push({taskId: t.id, title: t.title, action: 'failed', url: null, detail: e instanceof NotionWriteError ? e.message : 'Write failed.'});
      if (STOP.has(code)) stopped = true;
    }
  }

  const created = items.filter((i) => i.action === 'created').length;
  const updated = items.filter((i) => i.action === 'updated').length;
  const failed = items.filter((i) => i.action === 'failed').length;
  const outcome = failed && (created || updated) ? 'partial' : failed ? 'failed' : 'applied';

  const date = localDate(now());
  const briefing = opts.skipBriefing
    ? null
    : await runBriefing({userId, date, trigger: 'intake', idempotencyKey: `import:${userId}:${hash.slice(0, 16)}`}).catch(() => null);

  const message =
    outcome === 'applied'
      ? `Import applied: Blueprint v${saved.version}, ${created} created and ${updated} updated in Notion.`
      : outcome === 'partial'
        ? `Import partly applied: ${failed} item(s) could not be written. Blueprint v${saved.version} was saved.`
        : outcome === 'failed'
          ? `Blueprint v${saved.version} was saved, but Notion writes failed.`
          : 'Import applied.';

  return {outcome, blueprintVersion: saved.version, items, counts: preview.counts, message, briefing: briefing?.briefing ?? null};
}
