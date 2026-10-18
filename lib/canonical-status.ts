import type {Task} from './types';

/** Blueprint vocabulary. Notion remains the stored status; this is a read-only projection. */
export type CanonicalStatus = 'inbox' | 'next' | 'scheduled' | 'waiting' | 'someday' | 'done' | 'canceled';

const SOMEDAY = /^someday\/ideas$/i;

export function canonicalStatus(task: Task, today: string): CanonicalStatus {
  if (task.status === 'Done') return 'done';
  if (task.status === 'Canceled') return 'canceled';
  if (task.status === 'Waiting' || task.status === 'Waiting for User' || task.status === 'Blocked') return 'waiting';
  if (task.status === 'Inbox' || (task.project && SOMEDAY.test(task.project.trim()))) return 'someday';
  if (task.status === 'Needs Verification') return 'inbox';
  if (task.due && task.due.slice(0, 10) > today) return 'scheduled';
  return 'next';
}
