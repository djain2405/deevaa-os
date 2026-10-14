import type {ExtractedItem} from './intake-schema';
import type {TaskFields} from './notion-write';
import type {Task} from './types';

const STOP = new Set(
  'a an the my our your to of for and or on in at with about from by is are be it this that these those me i we some any up out do get make'.split(' ')
);

export function tokens(s: string) {
  return new Set(
    s
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w && !STOP.has(w))
      .map((w) => (w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
  );
}

const inter = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;
/** Symmetric similarity for spotting duplicate titles. */
export const dice = (a: string, b: string) => {
  const x = tokens(a);
  const y = tokens(b);
  return x.size + y.size ? (2 * inter(x, y)) / (x.size + y.size) : 0;
};
/** How much of a short reference ("my open-source PR") is covered by a task title. */
export const coverage = (ref: string, title: string) => {
  const x = tokens(ref);
  return x.size ? inter(x, tokens(title)) / x.size : 0;
};

const DUPLICATE = 0.75;
const REFERENCE = 0.6;
const CLEAR_LEAD = 0.25;

export type MatchResult = {kind: 'none'} | {kind: 'one'; task: Task} | {kind: 'ambiguous'; candidates: Task[]};

function pick(scored: {task: Task; score: number}[], threshold: number): MatchResult {
  const hits = scored.filter((s) => s.score >= threshold).sort((a, b) => b.score - a.score);
  if (!hits.length) return {kind: 'none'};
  if (hits.length === 1 || hits[0].score - hits[1].score >= CLEAR_LEAD) return {kind: 'one', task: hits[0].task};
  return {kind: 'ambiguous', candidates: hits.slice(0, 3).map((h) => h.task)};
}

export function matchExisting(it: ExtractedItem, tasks: Task[]): MatchResult {
  if (it.kind === 'new_task') return pick(tasks.map((task) => ({task, score: dice(it.title, task.title)})), DUPLICATE);
  const ref = it.target || it.title;
  return pick(tasks.map((task) => ({task, score: Math.max(coverage(ref, task.title), dice(ref, task.title))})), REFERENCE);
}

export type PlannedOp =
  | {action: 'create'; index: number; item: ExtractedItem; title: string; fields: TaskFields & {title: string}; changes: string[]}
  | {action: 'update'; index: number; item: ExtractedItem; title: string; task: Task; fields: TaskFields; changes: string[]}
  | {action: 'unchanged'; index: number; item: ExtractedItem; title: string; task: Task; changes: string[]}
  | {action: 'ambiguous'; index: number; item: ExtractedItem; title: string; candidates: Task[]; changes: string[]}
  | {action: 'skip'; index: number; item: ExtractedItem; title: string; reason: string; changes: string[]};

const CLOSED = new Set(['Done', 'Canceled']);
const fmt = (d: string | null | undefined) => d ?? 'none';

function describeCreate(f: TaskFields & {title: string}) {
  const out = [`Status ${f.status ?? 'Ready'}`];
  if (f.due) out.push(`Due ${f.due}`);
  if (f.priority) out.push(`Priority ${f.priority}`);
  if (f.duration) out.push(`Duration ${f.duration} min`);
  if (f.project) out.push(`Project ${f.project}`);
  if (f.nextAction) out.push(`Next: ${f.nextAction}`);
  return out;
}

/** Only fields the message actually supplies, and only when they differ from Notion. */
function diff(task: Task, it: ExtractedItem, status?: Task['status']) {
  const fields: TaskFields = {};
  const changes: string[] = [];
  if (status && status !== task.status) (fields.status = status), changes.push(`Status ${task.status} → ${status}`);
  if (it.due && it.due !== task.due?.slice(0, 10)) (fields.due = it.due), changes.push(`Due ${fmt(task.due?.slice(0, 10))} → ${it.due}`);
  if (it.priority && it.priority !== task.priority) (fields.priority = it.priority), changes.push(`Priority ${task.priority} → ${it.priority}`);
  if (it.durationMinutes && it.durationMinutes !== task.duration) (fields.duration = it.durationMinutes), changes.push(`Duration → ${it.durationMinutes} min`);
  if (it.project && it.project !== task.project) (fields.project = it.project), changes.push(`Project → ${it.project}`);
  if (it.nextAction && it.nextAction !== task.nextAction) (fields.nextAction = it.nextAction), changes.push(`Next: ${it.nextAction}`);
  return {fields, changes};
}

/** Decides create, update, skip or ask for every task-related item. Never picks between two plausible matches. */
export function planOps(items: ExtractedItem[], tasks: Task[]): PlannedOp[] {
  const open = tasks.filter((t) => !CLOSED.has(t.status));
  const planned: PlannedOp[] = [];
  const createdTitles: string[] = [];
  items.forEach((it, index) => {
    if (it.kind !== 'new_task' && it.kind !== 'status_update') return;
    if (it.kind === 'new_task' && createdTitles.some((t) => dice(t, it.title) >= DUPLICATE)) {
      planned.push({action: 'skip', index, item: it, title: it.title, reason: 'Mentioned twice in this message; recorded once.', changes: []});
      return;
    }
    const match = matchExisting(it, it.kind === 'status_update' && it.status === 'Done' ? tasks : open);

    if (match.kind === 'ambiguous') {
      planned.push({action: 'ambiguous', index, item: it, title: it.title, candidates: match.candidates, changes: []});
      return;
    }
    if (match.kind === 'one') {
      const {fields, changes} = diff(match.task, it, it.kind === 'status_update' ? it.status ?? undefined : undefined);
      if (!changes.length) planned.push({action: 'unchanged', index, item: it, title: match.task.title, task: match.task, changes: ['Already up to date in Notion']});
      else planned.push({action: 'update', index, item: it, title: match.task.title, task: match.task, fields, changes});
      return;
    }
    if (it.kind === 'status_update' && (it.status === 'Done' || it.status === 'Canceled')) {
      planned.push({action: 'skip', index, item: it, title: it.title, reason: `No matching Notion task, so nothing was marked ${it.status}.`, changes: []});
      return;
    }
    const fields: TaskFields & {title: string} = {
      title: it.title,
      status: it.kind === 'status_update' ? it.status ?? 'Ready' : it.status ?? 'Ready',
      due: it.due,
      priority: it.priority,
      duration: it.durationMinutes,
      project: it.project,
      nextAction: it.nextAction
    };
    for (const k of Object.keys(fields) as (keyof TaskFields)[]) if (fields[k] === null || fields[k] === undefined) delete fields[k];
    createdTitles.push(it.title);
    planned.push({action: 'create', index, item: it, title: it.title, fields, changes: describeCreate(fields)});
  });
  return planned;
}
