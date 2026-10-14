import {runBriefing} from '@/lib/briefing-service';
import type {IntakeDeps} from '@/lib/intake';
import {extractWithRules} from '@/lib/intake-rules';
import {groundItems} from '@/lib/intake-ai';
import {mismatches, NotionWriteError, type TaskFields, type WriteTarget} from '@/lib/notion-write';
import {localDate} from '@/lib/time';
import type {Task} from '@/lib/types';
import {connected, task} from './helpers';

export const TARGET: WriteTarget = {
  token: 'ntn_fake_token_should_never_leak_0000000000',
  dataSourceId: 'ds-1',
  titleProperty: 'Name',
  props: Object.fromEntries(
    [
      ['Name', 'title'],
      ['Status', 'select'],
      ['Priority', 'select'],
      ['Due', 'date'],
      ['Duration', 'number'],
      ['Project', 'rich_text'],
      ['NextAction', 'rich_text'],
      ['ExternalKey', 'rich_text']
    ].map(([n, type]) => [n, {type, options: []}])
  )
};

/** In-memory Notion that applies writes exactly as requested, with switchable failures. */
export function fakeNotion(initial: Task[] = []) {
  const pages = new Map(initial.map((t) => [t.id, {...t}]));
  const trashed = new Set<string>();
  const calls = {create: 0, update: 0, trash: 0, refresh: 0};
  let seq = 0;
  let clock = Date.parse('2026-10-14T03:00:00Z');
  const failures: {create?: NotionWriteError; update?: NotionWriteError; read?: boolean; verify?: boolean} = {};
  const stamp = () => new Date((clock += 60000)).toISOString();

  const apply = (t: Task, f: TaskFields): Task => ({
    ...t,
    title: f.title ?? t.title,
    status: f.status ?? t.status,
    priority: f.priority === undefined ? t.priority : f.priority ?? 'None',
    due: f.due === undefined ? t.due : f.due,
    duration: f.duration === undefined ? t.duration : f.duration,
    project: f.project === undefined ? t.project : f.project,
    nextAction: f.nextAction === undefined ? t.nextAction : f.nextAction,
    externalKey: f.externalKey === undefined ? t.externalKey : f.externalKey,
    lastEditedAt: stamp()
  });

  const deps: IntakeDeps = {
    extract: async (message, now) => {
      const {items, dropped} = groundItems(extractWithRules(message, now), message, now);
      return {items, reply: null, clarifications: dropped ? ['dropped'] : [], extractor: 'rules', note: null};
    },
    fetchTasks: async () =>
      failures.read
        ? {tasks: [], health: {state: 'error', message: 'Notion is unavailable right now.', lastSyncedAt: null, count: 0, warnings: []}}
        : {tasks: [...pages.values()].filter((t) => !trashed.has(t.id)), health: connected(pages.size)},
    target: async () => TARGET,
    create: async (_t, fields) => {
      calls.create++;
      if (failures.create) throw failures.create;
      const id = `page-${++seq}`;
      const created = apply(task({id, title: fields.title, status: 'Inbox', priority: 'None', duration: null, url: `https://www.notion.so/${id}`}), fields);
      pages.set(id, created);
      if (failures.verify || mismatches(created, fields).length) throw new NotionWriteError('verify_failed', 'verify failed');
      return {task: created, skipped: []};
    },
    update: async (_t, id, fields) => {
      calls.update++;
      if (failures.update) throw failures.update;
      const updated = apply(pages.get(id)!, fields);
      pages.set(id, updated);
      return {task: updated, skipped: []};
    },
    trash: async (_t, id) => {
      calls.trash++;
      trashed.add(id);
    },
    retrieve: async (_t, id) => {
      const t = pages.get(id);
      return t && !trashed.has(id) ? {task: t, trashed: false} : {task: null, trashed: true};
    },
    findByKey: async (_t, key) => [...pages.values()].find((t) => t.externalKey === key && !trashed.has(t.id)) ?? null,
    refresh: async (userId, changed, removed, key, now) => {
      calls.refresh++;
      const r = await runBriefing(
        {userId, date: localDate(now), trigger: 'intake', idempotencyKey: key},
        {
          fetchTasks: deps.fetchTasks,
          fetchEvents: async () => ({events: [], health: connected(0)}),
          enhance: async (b) => b,
          now: () => now
        }
      );
      void changed;
      void removed;
      return r.outcome;
    },
    now: () => new Date('2026-10-14T03:00:00Z')
  };
  return {deps, pages, trashed, calls, failures, edit: (id: string, f: TaskFields) => pages.set(id, apply(pages.get(id)!, f))};
}
