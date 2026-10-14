import {alignment, supports, type Blueprint} from './blueprint';
import {daysUntil} from './time';
import type {DecisionLane, Task} from './types';

const VERIFY_PATTERN = /\b(verify|confirm|check)\b.*\b(deadline|due|date)\b|\b(deadline|due date)\b.*\b(verify|confirm|check)\b/i;
const SOMEDAY_PROJECT = /^someday\/ideas$/i;

/** Lower index = ranks higher in the briefing. */
export const LANE_RANK: Record<DecisionLane, number> = {
  Critical: 0,
  'Due soon': 1,
  Important: 2,
  Scheduled: 3,
  Verify: 4,
  Someday: 5,
  Waiting: 6,
  Blocked: 7,
  Completed: 8
};

export function laneRank(lane: DecisionLane): number {
  return LANE_RANK[lane];
}

function asksToVerifyDeadline(task: Task): boolean {
  const text = `${task.title} ${task.nextAction ?? ''}`;
  return VERIFY_PATTERN.test(text);
}

function isBlocked(task: Task, byId: Map<string, Task>): boolean {
  if (task.status === 'Blocked') return true;
  if (task.blocker) return true;
  for (const dep of task.blockedBy) {
    const other = byId.get(dep);
    if (!other || (other.status !== 'Done' && other.status !== 'Canceled')) return true;
  }
  return false;
}

function unblocksCount(task: Task, tasks: Task[]): number {
  let n = 0;
  for (const t of tasks) {
    if (t.status === 'Done' || t.status === 'Canceled') continue;
    if (t.blockedBy.includes(task.id)) n++;
  }
  return n;
}

export type LaneInput = {
  task: Task;
  date: string;
  blueprint: Blueprint | null;
  byId: Map<string, Task>;
  tasks: Task[];
  unblocks?: number;
};

/** One explainable lane per task from Notion + confirmed Blueprint only. */
export function assignLane(input: LaneInput): DecisionLane {
  const {task, date, blueprint, byId, tasks} = input;
  const unblocks = input.unblocks ?? unblocksCount(task, tasks);

  if (task.status === 'Done' || task.status === 'Canceled') return 'Completed';
  if (task.status === 'Waiting' || task.status === 'Waiting for User') return 'Waiting';
  if (isBlocked(task, byId)) return 'Blocked';
  if (task.status === 'Inbox' || (task.project && SOMEDAY_PROJECT.test(task.project.trim()))) return 'Someday';
  if (task.status === 'Needs Verification' || (asksToVerifyDeadline(task) && task.due === null)) return 'Verify';

  if (task.due) {
    const d = daysUntil(task.due, date);
    const urgentish = task.priority === 'Urgent' || task.priority === 'High';
    if (d <= 2 && (urgentish || unblocks > 0)) return 'Critical';
    if (d >= 3 && d <= 7) return 'Due soon';
  }

  const fit = alignment(task, blueprint);
  if (task.priority === 'Urgent' || task.priority === 'High' || fit) return 'Important';

  return 'Important';
}

export function recommendNextAction(task: Task, lane: DecisionLane): string {
  if (lane === 'Verify') {
    return task.nextAction?.trim() || 'Verify the real deadline in Notion before scheduling this.';
  }
  if (task.nextAction?.trim()) return task.nextAction.trim();
  return 'Open in Notion and do the next concrete step.';
}

const CAREER_PHRASES = ['eb-1a', 'eb1a', 'gde', 'petition'];

/** Executable tasks tied to confirmed Blueprint career / immigration priorities. */
export function careerResearchTasks(tasks: Task[], blueprint: Blueprint | null): Task[] {
  if (!blueprint) return [];
  const phrases = [
    ...blueprint.goals,
    ...blueprint.quarterlyPriorities,
    ...blueprint.activeProjects,
    ...blueprint.context
  ].filter((p) => CAREER_PHRASES.some((k) => p.toLowerCase().includes(k)));
  const unique = [...new Set(phrases)];
  if (!unique.length) return [];
  return tasks.filter((t) => t.status !== 'Done' && t.status !== 'Canceled' && unique.some((phrase) => supports(t, phrase)));
}
