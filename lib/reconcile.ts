import {canonicalStatus, type CanonicalStatus} from './canonical-status';
import {dice} from './intake-match';
import type {Task, TaskStatus} from './types';

export type ReconciliationItem =
  | {title: string; kind: 'create'; canonical: CanonicalStatus}
  | {title: string; kind: 'update'; taskId: string; from: CanonicalStatus; to: CanonicalStatus}
  | {title: string; kind: 'unchanged'; taskId: string; canonical: CanonicalStatus}
  | {title: string; kind: 'conflict'; reason: string; taskIds: string[]};

/** Preview only. Callers still go through the verified Notion writer. */
export function reconciliationPreview(
  tasks: Task[],
  incoming: {title: string; status?: TaskStatus}[],
  today: string
): ReconciliationItem[] {
  const open = tasks.filter((t) => t.status !== 'Done' && t.status !== 'Canceled');
  return incoming.map((item) => {
    const hits = open.filter((t) => dice(t.title, item.title) >= 0.75);
    if (hits.length > 1) {
      return {title: item.title, kind: 'conflict', reason: 'More than one open task matches. Nothing should be written until you pick one.', taskIds: hits.map((t) => t.id)};
    }
    if (hits.length === 1) {
      const task = hits[0];
      const from = canonicalStatus(task, today);
      if (!item.status || item.status === task.status) return {title: item.title, kind: 'unchanged', taskId: task.id, canonical: from};
      if ((task.status === 'Done' || task.status === 'Canceled') && item.status !== task.status) {
        return {title: item.title, kind: 'conflict', reason: 'A closed task is not reopened from a casual mention.', taskIds: [task.id]};
      }
      const projected = {...task, status: item.status};
      return {title: item.title, kind: 'update', taskId: task.id, from, to: canonicalStatus(projected, today)};
    }
    const created = {
      id: 'new',
      title: item.title,
      status: item.status ?? 'Ready',
      rawStatus: null,
      priority: 'None' as const,
      due: null,
      duration: null,
      context: 'Anywhere' as const,
      energy: 'Low' as const,
      blocker: null,
      blockedBy: [],
      externalKey: null,
      project: null,
      nextAction: null,
      url: '',
      sourceLink: null,
      source: 'notion' as const,
      lastEditedAt: ''
    };
    return {title: item.title, kind: 'create', canonical: canonicalStatus(created, today)};
  });
}
