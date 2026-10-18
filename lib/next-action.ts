import type {Context, Energy, RankedTask} from './types';

export const ACTION_WINDOWS = [5, 10, 20, 45] as const;
export const ENERGY_LEVELS: Energy[] = ['Low', 'Medium', 'High'];
export const CONTEXTS: Context[] = ['Anywhere', 'Phone', 'Laptop', 'Home'];
export const FEEDBACK_KINDS = [
  'done',
  'not_now',
  'not_possible_here',
  'wrong',
  'replace',
  'shrink',
  'skip',
  'complete',
  'not_relevant',
  'postpone',
  'explain'
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type Feedback = {taskId: string; kind: FeedbackKind; context: string | null; createdAt: string};

const energyRank: Record<Energy, number> = {Low: 0, Medium: 1, High: 2};
const HOUR = 3600 * 1000;
/** Getting into a task costs time. A 5-minute window holds a 3-minute task, not a 5-minute one. */
export const SETUP_MINUTES = 2;
const WRONG_PENALTY = 30;

export type NextAction =
  | {kind: 'task'; task: RankedTask; reason: string; doneDefinition: string}
  | {kind: 'rest'; reason: string};

/** Recent feedback that keeps a task out of this pick, or lowers it. */
function feedbackEffect(feedback: Feedback[], taskId: string, context: Context, now: number) {
  let skip: string | null = null;
  let penalty = 0;
  for (const f of feedback) {
    if (f.taskId !== taskId) continue;
    const age = now - Date.parse(f.createdAt);
    if ((f.kind === 'done' || f.kind === 'complete') && age < 24 * HOUR) skip = 'you marked it done';
    if ((f.kind === 'not_now' || f.kind === 'skip' || f.kind === 'postpone') && age < 3 * HOUR) skip = 'you said not now';
    if (f.kind === 'not_possible_here' && age < 7 * 24 * HOUR && f.context === context) skip = `you said it is not possible on ${context.toLowerCase()}`;
    if ((f.kind === 'wrong' || f.kind === 'not_relevant') && age < 14 * 24 * HOUR) penalty += WRONG_PENALTY;
  }
  return {skip, penalty};
}

/** Picks one existing task that genuinely fits; otherwise recommends rest instead of inventing work. */
export function findNextAction(
  tasks: RankedTask[],
  input: {minutes: number; energy: Energy; context: Context; skipIds?: string[]; feedback?: Feedback[]; now?: Date}
): NextAction {
  const skip = new Set(input.skipIds ?? []);
  const now = (input.now ?? new Date()).getTime();
  const usable = input.minutes - SETUP_MINUTES;
  const fits = tasks
    .filter((t) => t.executable && !skip.has(t.id))
    .filter((t) => t.duration !== null && t.duration <= usable)
    .filter((t) => energyRank[t.energy] <= energyRank[input.energy])
    .filter((t) => input.context === 'Anywhere' || t.context === 'Anywhere' || t.context === input.context)
    .map((t) => ({t, fx: feedbackEffect(input.feedback ?? [], t.id, input.context, now)}))
    .filter(({fx}) => !fx.skip)
    .sort((a, b) => b.t.score - b.fx.penalty - (a.t.score - a.fx.penalty));

  const pick = fits[0];
  if (pick) {
    const t = pick.t;
    const why = t.reasons.slice(0, 2).join(' · ');
    return {
      kind: 'task',
      task: t,
      reason: `${why ? `${why} · ` : ''}${t.duration}-minute estimate plus ${SETUP_MINUTES} minutes to get started fits your ${input.minutes}-minute window.${pick.fx.penalty ? ' Ranked lower because you flagged it as a wrong recommendation recently.' : ''}`,
      doneDefinition: 'Work on this one task only. Tell Deevaa when it is done, or mark it Done in Notion; Deevaa will not assume it is finished.'
    };
  }
  const undated = tasks.filter((t) => t.executable && t.duration === null).length;
  return {
    kind: 'rest',
    reason:
      `Nothing ready fits ${input.minutes} minutes at ${input.energy.toLowerCase()} energy${input.context === 'Anywhere' ? '' : ` on ${input.context.toLowerCase()}`}, once you allow ${SETUP_MINUTES} minutes to get started. ` +
      'Rest or transition instead; that is a valid use of this window.' +
      (undated ? ` ${undated} ready task(s) have no Duration in Notion, so they are not offered for short windows.` : '')
  };
}
