import {DateTime} from 'luxon';
import {alignment, type Blueprint} from './blueprint';
import {atLocal, daysUntil, formatLocalTime, localDate} from './time';
import {
  BRIEFING_VERSION,
  TIMEZONE,
  type Block,
  type BriefingSnapshot,
  type CalendarEvent,
  type Interval,
  type RadarItem,
  type RankedTask,
  type SourceHealth,
  type Task,
  type TaskRef,
  type TaskStatus
} from './types';

export const DAY_START = {hour: 7, minute: 0};
export const DAY_END = {hour: 22, minute: 30};
export const PREP_MINUTES = 10;
export const TRANSITION_MINUTES = 10;
const MIN_GAP = 5;
const UNKNOWN_FOCUS_MINUTES = 45;
const MAX_FOCUS_MINUTES = 90;
const FOCUS_MIN = 25;
const CLOSE_MAX = 15;
const EXPAND_MINUTES = 30;
/** After the first block, leave at least this share of open time unplanned so a full day is not packed further. */
const MAX_PLANNED_SHARE = 0.7;
const MAINTAIN_PATTERN = /\b(home|health|fitness|gym|meal|cook|groceries|laundry|clean|tidy|appointment|doctor|dentist|walk|exercise|sleep|rest)\b/i;

const EXCLUDED: Partial<Record<TaskStatus, string>> = {
  Inbox: 'In Inbox; triage it in Notion before it is scheduled.',
  Waiting: 'Waiting on someone else.',
  'Waiting for User': 'Waiting for your input; set it to Ready in Notion when it can be worked.',
  Blocked: 'Marked Blocked in Notion.',
  Done: 'Done in Notion.',
  Canceled: 'Canceled in Notion.',
  'Needs Verification': 'Status is unclear in Notion; verify it before acting.'
};

const PRIORITY_SCORE = {Urgent: 100, High: 60, Medium: 30, Low: 10, None: 20} as const;

export const toRef = (t: Task | RankedTask): TaskRef => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  due: t.due,
  duration: t.duration,
  url: t.url,
  sourceLink: t.sourceLink,
  source: t.source,
  project: t.project ?? null
});

function exclusion(task: Task, byId: Map<string, Task>): string | null {
  const byStatus = EXCLUDED[task.status];
  if (byStatus) return byStatus;
  if (task.blocker) return 'Has a Blocker noted in Notion.';
  for (const dep of task.blockedBy) {
    const other = byId.get(dep);
    if (!other) return 'Depends on a task Deevaa cannot see; verify the dependency.';
    if (other.status !== 'Done' && other.status !== 'Canceled') return `Waiting on “${other.title}”.`;
  }
  return null;
}

export function rankTasks(tasks: Task[], date: string, blueprint: Blueprint | null = null): RankedTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const unblocks = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === 'Done' || t.status === 'Canceled') continue;
    for (const dep of t.blockedBy) unblocks.set(dep, (unblocks.get(dep) ?? 0) + 1);
  }
  const ranked = tasks.map((t): RankedTask => {
    const reasons: string[] = [];
    let score = PRIORITY_SCORE[t.priority];
    if (t.priority !== 'None') reasons.push(`${t.priority} priority`);
    if (t.due) {
      const d = daysUntil(t.due, date);
      if (d < 0) (score += 60), reasons.push(`overdue by ${-d} day${d === -1 ? '' : 's'}`);
      else if (d === 0) (score += 45), reasons.push('due today');
      else if (d === 1) (score += 30), reasons.push('due tomorrow');
      else if (d <= 3) (score += 20), reasons.push(`due in ${d} days`);
      else if (d <= 7) (score += 8), reasons.push(`due in ${d} days`);
    }
    if (t.status === 'In Progress') (score += 15), reasons.push('already in progress');
    const n = unblocks.get(t.id) ?? 0;
    if (n) (score += Math.min(24, 8 * n)), reasons.push(`unblocks ${n} other task${n === 1 ? '' : 's'}`);
    if (t.duration !== null) score += 3;
    const fit = alignment(t, blueprint);
    if (fit) (score += fit.bonus), reasons.push(fit.reason);
    const excludedReason = exclusion(t, byId);
    return {...toRef(t), context: t.context, energy: t.energy, score, reasons, executable: excludedReason === null, excludedReason};
  });
  return ranked.sort(
    (a, b) =>
      Number(b.executable) - Number(a.executable) ||
      b.score - a.score ||
      (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
      (a.duration ?? 9999) - (b.duration ?? 9999) ||
      a.title.localeCompare(b.title)
  );
}

type Gap = {start: DateTime; end: DateTime};
const minutes = (g: Gap) => g.end.diff(g.start, 'minutes').minutes;

export function freeWindows(date: string, events: CalendarEvent[], now: Date): Gap[] {
  let start = atLocal(date, DAY_START.hour, DAY_START.minute);
  const end = atLocal(date, DAY_END.hour, DAY_END.minute);
  const nowLocal = DateTime.fromJSDate(now).setZone(TIMEZONE);
  if (nowLocal > start) {
    const rounded = nowLocal.plus({minutes: (5 - (nowLocal.minute % 5)) % 5}).startOf('minute');
    start = rounded > start ? rounded : start;
  }
  if (start >= end) return [];

  const busy = events
    .filter((e) => e.busy && !e.allDay)
    .map((e) => ({
      start: DateTime.fromISO(e.start, {setZone: true}).setZone(TIMEZONE).minus({minutes: PREP_MINUTES}),
      end: DateTime.fromISO(e.end, {setZone: true}).setZone(TIMEZONE).plus({minutes: TRANSITION_MINUTES})
    }))
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const gaps: Gap[] = [];
  let cursor = start;
  for (const b of busy) {
    if (b.end <= cursor) continue;
    if (b.start >= end) break;
    if (b.start > cursor) gaps.push({start: cursor, end: b.start < end ? b.start : end});
    if (b.end > cursor) cursor = b.end;
  }
  if (cursor < end) gaps.push({start: cursor, end});
  return gaps.filter((g) => minutes(g) >= MIN_GAP);
}

class Allocator {
  private planned = 0;
  constructor(private gaps: Gap[], private budget: number) {}
  hasSpace(length: number) {
    return this.gaps.some((g) => minutes(g) >= length);
  }
  place(length: number): Interval | null {
    if (this.planned > 0 && this.planned + length > this.budget) return null;
    const gap = this.gaps.find((g) => minutes(g) >= length);
    if (!gap) return null;
    const slot = {start: gap.start, end: gap.start.plus({minutes: length})};
    gap.start = slot.end.plus({minutes: TRANSITION_MINUTES});
    this.gaps = this.gaps.filter((g) => minutes(g) >= MIN_GAP);
    this.planned += length;
    return {start: slot.start.toISO()!, end: slot.end.toISO()!};
  }
}

const window = (slot: Interval) => `${formatLocalTime(slot.start)}–${formatLocalTime(slot.end)}`;

export function planBlocks(ranked: RankedTask[], gaps: Gap[] | null): Block[] {
  const ready = ranked.filter((t) => t.executable);
  const used = new Set<string>();
  const freeTotal = gaps ? gaps.reduce((s, g) => s + minutes(g), 0) : 0;
  const alloc = gaps ? new Allocator(gaps.map((g) => ({...g})), Math.floor(freeTotal * MAX_PLANNED_SHARE)) : null;
  const noCalendar = 'Calendar not connected, so no time window is claimed.';

  function assign(label: Block['label'], candidates: RankedTask[], length: (t: RankedTask) => number, why: string, none: string): Block {
    if (!candidates.length) return {label, state: 'omitted', task: null, start: null, end: null, reason: none};
    if (!alloc) {
      const t = candidates[0];
      used.add(t.id);
      return {label, state: 'unscheduled', task: toRef(t), start: null, end: null, reason: `${why} ${noCalendar}`};
    }
    for (const t of candidates) {
      const slot = alloc.place(length(t));
      if (slot) {
        used.add(t.id);
        const unknown = t.duration === null ? ' Duration is not set in Notion, so a 45-minute block is assumed.' : '';
        return {label, state: 'scheduled', task: toRef(t), start: slot.start, end: slot.end, reason: `${why} Open ${window(slot)}.${unknown}`};
      }
    }
    const shortest = Math.min(...candidates.map(length));
    if (alloc.hasSpace(shortest)) {
      return {label, state: 'omitted', task: null, start: null, end: null, reason: 'Skipped to keep slack in an already full day.'};
    }
    return {
      label,
      state: 'omitted',
      task: null,
      start: null,
      end: null,
      reason: `No open ${shortest}-minute window remains after meetings, preparation, transitions and protected sleep (10:30 PM–7:00 AM).`
    };
  }

  const focusLength = (t: RankedTask) => Math.min(t.duration ?? UNKNOWN_FOCUS_MINUTES, MAX_FOCUS_MINUTES);
  const focus = assign(
    'FOCUS',
    ready.filter((t) => t.duration === null || t.duration >= FOCUS_MIN),
    focusLength,
    'Highest-ranked task that needs sustained attention.',
    'No ready Notion task needs a focus window today.'
  );
  const close = assign(
    'CLOSE',
    ready.filter((t) => !used.has(t.id) && t.duration !== null && t.duration <= CLOSE_MAX),
    (t) => t.duration!,
    'One small open loop; do not stack more.',
    'No ready task of 15 minutes or less.'
  );
  const maintain = assign(
    'MAINTAIN',
    ready.filter((t) => !used.has(t.id) && t.duration !== null && (t.context === 'Home' || MAINTAIN_PATTERN.test(t.title))),
    (t) => t.duration!,
    'Supports health or home.',
    'No ready health or home task; skipped instead of inventing one.'
  );
  let expand: Block;
  if (!alloc) expand = {label: 'EXPAND', state: 'unscheduled', task: null, start: null, end: null, reason: `Leave room for people, learning, connection or creativity. ${noCalendar}`};
  else {
    const slot = alloc.place(EXPAND_MINUTES);
    expand = slot
      ? {label: 'EXPAND', state: 'scheduled', task: null, start: slot.start, end: slot.end, reason: `Reserved for people, learning, connection or creativity. No task is assigned on purpose. Open ${window(slot)}.`}
      : {
          label: 'EXPAND',
          state: 'omitted',
          task: null,
          start: null,
          end: null,
          reason: alloc.hasSpace(EXPAND_MINUTES) ? 'Skipped to keep slack in an already full day.' : 'Not enough open time left; skipped rather than overbooking the day.'
        };
  }
  return [focus, close, maintain, expand];
}

const RADAR_ORDER: RadarItem['kind'][] = ['blocked_deadline', 'overdue', 'due_soon', 'stale_waiting'];
const STALE_WAITING_DAYS = 7;
const MAX_RADAR = 8;
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** Deadline and follow-up warnings from Notion data only; nothing here is inferred or sent anywhere. */
export function buildRadar(ranked: RankedTask[], tasks: Task[], date: string): RadarItem[] {
  const edited = new Map(tasks.map((t) => [t.id, t.lastEditedAt]));
  const today = atLocal(date, 12, 0);
  const items: RadarItem[] = [];
  for (const t of ranked) {
    if (t.status === 'Done' || t.status === 'Canceled') continue;
    const d = t.due ? daysUntil(t.due, date) : null;
    const waiting = t.status === 'Waiting' || t.status === 'Waiting for User';
    const stuck = !t.executable && !waiting;
    const editedAt = edited.get(t.id);
    const idle = editedAt ? Math.floor(today.diff(DateTime.fromISO(editedAt), 'days').days) : 0;
    let item: RadarItem | null = null;
    if (stuck && d !== null && d <= 7) item = {kind: 'blocked_deadline', task: toRef(t), detail: `${t.excludedReason ?? 'Not actionable.'} Due ${d < 0 ? `${days(-d)} ago` : d === 0 ? 'today' : `in ${days(d)}`}.`};
    else if (d !== null && d < 0) item = {kind: 'overdue', task: toRef(t), detail: `Overdue by ${days(-d)}.`};
    else if (d !== null && d <= 2) item = {kind: 'due_soon', task: toRef(t), detail: d === 0 ? 'Due today.' : `Due in ${days(d)}.`};
    else if (waiting && idle >= STALE_WAITING_DAYS) item = {kind: 'stale_waiting', task: toRef(t), detail: `${t.status} with no Notion update for ${days(idle)}. Consider following up.`};
    if (item) items.push(item);
  }
  return items
    .sort((a, b) => RADAR_ORDER.indexOf(a.kind) - RADAR_ORDER.indexOf(b.kind) || (a.task.due ?? '9999').localeCompare(b.task.due ?? '9999'))
    .slice(0, MAX_RADAR);
}

export type PlanInput = {
  date: string;
  now?: Date;
  tasks: Task[];
  events: CalendarEvent[];
  notion: SourceHealth;
  calendar: SourceHealth;
  blueprint?: Blueprint | null;
};

export function buildBriefing(input: PlanInput): BriefingSnapshot {
  const now = input.now ?? new Date();
  const warnings = [...input.notion.warnings, ...input.calendar.warnings];
  const notionOk = input.notion.state === 'connected';
  const calendarOk = input.calendar.state === 'connected';

  if (input.notion.state === 'error') warnings.unshift(`Notion: ${input.notion.message} No tasks are recommended until it is fixed.`);
  if (input.notion.state === 'not_connected') warnings.unshift('Notion is not connected, so there are no tasks to recommend.');
  if (input.calendar.state === 'error') warnings.unshift(`Google Calendar: ${input.calendar.message} Free time is not claimed.`);
  if (input.calendar.state === 'not_connected') warnings.unshift('Google Calendar is not connected, so Deevaa does not claim any free time.');
  if (input.date < localDate(now)) warnings.push('This briefing is for a past date.');

  const ranked = notionOk ? rankTasks(input.tasks, input.date, input.blueprint ?? null) : [];
  const gaps = calendarOk ? freeWindows(input.date, input.events, now) : null;
  const blocks: Block[] = notionOk
    ? planBlocks(ranked, gaps)
    : (['FOCUS', 'CLOSE', 'MAINTAIN', 'EXPAND'] as const).map((label) => ({
        label,
        state: 'omitted' as const,
        task: null,
        start: null,
        end: null,
        reason: 'No valid Notion task data, so no recommendation is made.'
      }));

  const ready = ranked.filter((t) => t.executable);
  const topOutcomes = ready.slice(0, 3).map((t) => ({task: toRef(t), reasons: t.reasons}));
  const freeMinutes = gaps ? Math.round(gaps.reduce((s, g) => s + minutes(g), 0)) : null;
  const busyMinutes = calendarOk
    ? Math.round(
        input.events
          .filter((e) => e.busy)
          .reduce((s, e) => s + DateTime.fromISO(e.end).diff(DateTime.fromISO(e.start), 'minutes').minutes, 0)
      )
    : null;

  const status: BriefingSnapshot['status'] =
    input.notion.state === 'not_connected' ? 'unavailable' : notionOk && calendarOk ? 'complete' : 'partial';

  const scheduled = blocks.filter((b) => b.state === 'scheduled').length;
  const summary = !notionOk
    ? 'No grounded plan is available because Notion task data is missing.'
    : [
        `${ready.length} ready task${ready.length === 1 ? '' : 's'}, ${ranked.length - ready.length} not actionable now.`,
        freeMinutes === null ? 'Free time is unknown.' : `${Math.floor(freeMinutes / 60)}h ${freeMinutes % 60}m open between commitments.`,
        gaps ? `${scheduled} of 4 blocks fit.` : '',
        topOutcomes[0] ? `Start with “${topOutcomes[0].task.title}”.` : ''
      ]
        .filter(Boolean)
        .join(' ');

  return {
    version: BRIEFING_VERSION,
    date: input.date,
    timezone: TIMEZONE,
    generatedAt: now.toISOString(),
    status,
    summary,
    sources: {notion: input.notion, calendar: input.calendar},
    warnings,
    topOutcomes,
    blocks,
    radar: notionOk ? buildRadar(ranked, input.tasks, input.date) : [],
    tasks: ranked,
    events: calendarOk ? input.events : [],
    capacity: {
      known: calendarOk,
      freeMinutes,
      busyMinutes,
      freeWindows: gaps ? gaps.map((g) => ({start: g.start.toISO()!, end: g.end.toISO()!})) : []
    },
    ai: {status: 'disabled', detail: null}
  };
}
