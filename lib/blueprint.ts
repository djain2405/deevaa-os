import {z} from 'zod';
import {tokens} from './intake-match';

const lines = z.array(z.string().trim().min(1).max(240)).max(30);

/** User-confirmed context only. Inferred notes live in blueprint_suggestions until the user approves them. */
export const Blueprint = z.strictObject({
  goals: lines,
  quarterlyPriorities: lines,
  activeProjects: lines,
  pausedProjects: lines,
  routines: lines,
  preferences: lines,
  recurringCommitments: lines,
  schedulingConstraints: lines,
  energy: lines,
  boundaries: lines,
  experiments: lines,
  lessons: lines,
  context: lines,
  values: lines,
  identity: lines,
  nonNegotiables: lines
});
export type Blueprint = z.infer<typeof Blueprint>;
export type BlueprintField = keyof Blueprint;

export const BLUEPRINT_FIELDS: {key: BlueprintField; label: string; hint: string}[] = [
  {key: 'goals', label: 'Long-term goals', hint: 'What you are working toward over years.'},
  {key: 'quarterlyPriorities', label: 'This quarter’s priorities', hint: 'Tasks that support these rank higher.'},
  {key: 'activeProjects', label: 'Active projects', hint: 'Match the Project field in Notion to boost related tasks.'},
  {key: 'pausedProjects', label: 'Paused projects', hint: 'Related tasks rank lower until you resume them.'},
  {key: 'routines', label: 'Routines', hint: 'Recurring personal routines.'},
  {key: 'preferences', label: 'Preferences', hint: 'How you like to work.'},
  {key: 'recurringCommitments', label: 'Recurring commitments', hint: 'Standing obligations outside your calendar.'},
  {key: 'schedulingConstraints', label: 'Scheduling constraints', hint: 'Dates and limits to respect.'},
  {key: 'energy', label: 'Energy and capacity', hint: 'When you have more or less energy.'},
  {key: 'boundaries', label: 'Approval and privacy boundaries', hint: 'What Deevaa must never do or touch.'},
  {key: 'experiments', label: 'Current behavioral experiments', hint: 'Habits you are trying out.'},
  {key: 'lessons', label: 'Lessons', hint: 'Reflections you want to keep.'},
  {key: 'context', label: 'Personal context', hint: 'Facts you have confirmed and want Deevaa to remember.'},
  {key: 'values', label: 'Values', hint: 'What you refuse to trade away.'},
  {key: 'identity', label: 'Desired identity', hint: 'Who you are practicing being.'},
  {key: 'nonNegotiables', label: 'Non-negotiables', hint: 'Constraints that outrank a busy day.'}
];

export const emptyBlueprint = (): Blueprint => Object.fromEntries(BLUEPRINT_FIELDS.map((f) => [f.key, []])) as unknown as Blueprint;

export function blueprintHasContent(data: Blueprint) {
  return BLUEPRINT_FIELDS.some((f) => data[f.key].length > 0);
}

/** Where a confirmed chat note goes. */
export const SUGGESTION_FIELD: Record<string, BlueprintField> = {
  goal: 'goals',
  preference: 'preferences',
  personal_context: 'context',
  boundary: 'boundaries',
  reflection: 'lessons',
  capacity: 'energy',
  project: 'activeProjects',
  constraint: 'schedulingConstraints'
};

export function parseBlueprint(data: unknown): Blueprint {
  const parsed = Blueprint.safeParse({...emptyBlueprint(), ...(typeof data === 'object' && data ? data : {})});
  return parsed.success ? parsed.data : emptyBlueprint();
}

/** True when a task's title or Project clearly refers to a Blueprint entry. */
export function supports(task: {title: string; project?: string | null}, phrase: string) {
  const p = tokens(phrase);
  if (!p.size) return false;
  if (task.project && tokens(task.project).size && [...tokens(task.project)].every((w) => p.has(w))) return true;
  const t = tokens(`${task.title} ${task.project ?? ''}`);
  const overlap = [...p].filter((w) => t.has(w)).length;
  return overlap >= 2 || (overlap === 1 && p.size === 1);
}

export type Alignment = {bonus: number; reason: string} | null;

/** Connects a task to the confirmed Blueprint so ranking reflects goals, not only due dates. */
export function alignment(task: {title: string; project?: string | null}, bp: Blueprint | null): Alignment {
  if (!bp) return null;
  const hit = (list: string[]) => list.find((x) => supports(task, x));
  let h: string | undefined;
  if ((h = hit(bp.pausedProjects))) return {bonus: -15, reason: `project “${h}” is paused`};
  if ((h = hit(bp.quarterlyPriorities))) return {bonus: 25, reason: `supports this quarter’s priority “${h}”`};
  if ((h = hit(bp.activeProjects))) return {bonus: 12, reason: `part of active project “${h}”`};
  if ((h = hit(bp.goals))) return {bonus: 10, reason: `supports goal “${h}”`};
  return null;
}
