import {DateTime} from 'luxon';
import {alignment, type Blueprint} from './blueprint';
import {assignLane, careerResearchTasks, laneRank, recommendNextAction} from './decision';
import {composeBlocks} from './planner/compose';
import {snapshotFromPlanInput, type PlannerApproval, type PlannerFeedback} from './planner/snapshot';
import {planBlocksV1} from './planner/v1';
import {DAY_END, DAY_START, MIN_GAP, PREP_MINUTES, TRANSITION_MINUTES, freeWindows as freeWindowsFor, gapMinutes, type Gap} from './planner/windows';
import type {ConversationState} from './planner/conversation-state';
import {atLocal, daysUntil, localDate} from './time';
import {
  BLOCK_ROLE,
  BRIEFING_VERSION,
  TIMEZONE,
  type Block,
  type BriefingSnapshot,
  type CalendarEvent,
  type AgentDeliverable,
  type DecisionLane,
  type RadarItem,
  type RankedTask,
  type SourceHealth,
  type Task,
  type TaskRef,
  type TaskStatus,
  type EmailDigest
} from './types';

export {DAY_END, DAY_START, PREP_MINUTES, TRANSITION_MINUTES};
export {planBlocksV1} from './planner/v1';

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
    const lane = assignLane({task: t, date, blueprint, byId, tasks, unblocks: n});
    if (lane !== 'Completed' && lane !== 'Waiting' && lane !== 'Blocked' && lane !== 'Someday' && lane !== 'Verify') {
      reasons.unshift(`${lane} lane`);
    } else if (lane === 'Verify') reasons.unshift('Verify lane — deadline uncertain');
    return {...toRef(t), lane, context: t.context, energy: t.energy, score, reasons, executable: excludedReason === null, excludedReason};
  });
  return ranked.sort(
    (a, b) =>
      laneRank(a.lane) - laneRank(b.lane) ||
      b.score - a.score ||
      (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
      (a.duration ?? 9999) - (b.duration ?? 9999) ||
      a.title.localeCompare(b.title)
  );
}

const EXECUTABLE_LANES = new Set<DecisionLane>(['Critical', 'Due soon', 'Important', 'Scheduled']);

export function applyScheduledLanes(ranked: RankedTask[], blocks: Block[]): RankedTask[] {
  const scheduledIds = new Set(blocks.filter((b) => b.state === 'scheduled' && b.task).map((b) => b.task!.id));
  if (!scheduledIds.size) return ranked;
  return ranked.map((t) => {
    if (!scheduledIds.has(t.id) || !t.executable || t.lane === 'Critical' || t.lane === 'Due soon' || t.lane === 'Verify') return t;
    const reasons = t.reasons.includes('Scheduled lane') ? t.reasons : ['Scheduled lane', ...t.reasons.filter((r) => !r.endsWith(' lane') && r !== 'Verify lane — deadline uncertain')];
    return {...t, lane: 'Scheduled' as DecisionLane, reasons};
  });
}

function verifyRadarItems(ranked: RankedTask[]): RadarItem[] {
  return ranked
    .filter((t) => t.lane === 'Verify')
    .map((t) => ({
      kind: 'verify_deadline' as const,
      task: toRef(t),
      detail: t.excludedReason ?? 'Deadline is not set in Notion; verify before acting.'
    }));
}

function buildAgentWork(top: RankedTask[], radar: RadarItem[], ranked: RankedTask[], tasks: Task[], blueprint: Blueprint | null): AgentDeliverable[] {
  const out: AgentDeliverable[] = [];
  if (top.length) {
    out.push({
      agent: 'Chief of Staff',
      status: 'Prepared',
      summary: `Top ${top.length} priorit${top.length === 1 ? 'y' : 'ies'}: ${top.map((t) => `“${t.title}”`).join(', ')}.`,
      taskIds: top.map((t) => t.id)
    });
  }
  if (radar.length) {
    out.push({
      agent: 'Project Manager',
      status: 'Prepared',
      summary: `${radar.length} attention signal${radar.length === 1 ? '' : 's'} (deadlines, blocked work, stale waiting, uncertain deadlines).`,
      taskIds: radar.map((r) => r.task.id)
    });
  }
  const career = careerResearchTasks(tasks, blueprint).filter((t) => {
    const r = ranked.find((x) => x.id === t.id);
    return r && EXECUTABLE_LANES.has(r.lane);
  });
  if (career.length) {
    out.push({
      agent: 'Career & Research',
      status: 'Prepared',
      summary: `${career.length} grounded task${career.length === 1 ? '' : 's'} aligned with career / petition priorities.`,
      taskIds: career.map((t) => t.id)
    });
  }
  return out;
}

export function freeWindows(date: string, events: CalendarEvent[], now: Date, timezone: string = TIMEZONE): Gap[] {
  return freeWindowsFor(date, events, now, timezone);
}

export function planBlocks(ranked: RankedTask[], gaps: Gap[] | null, opts?: {maxShare?: number}): Block[] {
  return planBlocksV1(ranked, gaps, {maxShare: opts?.maxShare, toRef});
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
  /** Tired days skip high-energy work and leave more of the day unscheduled. */
  capacityMode?: 'normal' | 'tired';
  /** ISO timestamp. Free windows after this are not used. */
  hardStop?: string;
  timezone?: string;
  previousDigest?: EmailDigest | null;
  approvals?: PlannerApproval[];
  feedback?: PlannerFeedback[];
  conversation?: ConversationState;
  hasPrivateMaintainSignal?: boolean;
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

  const zone = input.timezone || TIMEZONE;
  const snapshot = snapshotFromPlanInput({...input, now, timezone: zone});
  let ranked = notionOk ? rankTasks(input.tasks, input.date, input.blueprint ?? null) : [];
  if (snapshot.capacityMode === 'tired') {
    ranked = ranked.map((t) =>
      t.energy === 'High'
        ? {...t, executable: false, excludedReason: 'High-energy work is skipped on a tired day.', reasons: [...t.reasons, 'Tired day: high energy skipped']}
        : t
    );
  }
  let gaps = calendarOk ? freeWindows(input.date, input.events, now, zone) : null;
  if (gaps && input.hardStop) {
    const stop = DateTime.fromISO(input.hardStop).setZone(zone);
    if (stop.isValid) {
      gaps = gaps
        .flatMap((gap) => {
          if (gap.start >= stop) return [];
          return [gap.end > stop ? {...gap, end: stop} : gap];
        })
        .filter((gap) => gapMinutes(gap) >= MIN_GAP);
    }
  }
  const composed = notionOk ? composeBlocks(snapshot, gaps) : null;
  const blocks: Block[] = composed
    ? composed.blocks
    : (['FOCUS', 'CLOSE', 'MAINTAIN', 'EXPAND'] as const).map((label) => ({
        label,
        role: BLOCK_ROLE[label],
        state: 'omitted' as const,
        task: null,
        start: null,
        end: null,
        reason: 'No valid Notion task data, so no recommendation is made.'
      }));
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const ready = ranked.filter((t) => t.executable && EXECUTABLE_LANES.has(t.lane));
  const topOutcomes = ready.slice(0, 3).map((t) => ({
    task: toRef(t),
    reasons: t.reasons,
    lane: t.lane,
    nextAction: recommendNextAction(byId.get(t.id) ?? ({...t, nextAction: null, blocker: null, blockedBy: [], rawStatus: null, externalKey: null, lastEditedAt: '', context: t.context, energy: t.energy} as Task), t.lane)
  }));
  const waiting = ranked.filter((t) => t.lane === 'Waiting');
  const radarBase = notionOk ? buildRadar(ranked, input.tasks, input.date) : [];
  const radar = notionOk ? [...radarBase, ...verifyRadarItems(ranked)] : [];
  const agentWork = notionOk ? buildAgentWork(topOutcomes.map((o) => ranked.find((t) => t.id === o.task.id)!), radar, ranked, input.tasks, input.blueprint ?? null) : [];

  if (notionOk) {
    ranked = applyScheduledLanes(ranked, blocks);
    ranked = [...ranked].sort(
      (a, b) =>
        laneRank(a.lane) - laneRank(b.lane) ||
        b.score - a.score ||
        (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
        (a.duration ?? 9999) - (b.duration ?? 9999) ||
        a.title.localeCompare(b.title)
    );
  }
  const freeMinutes = gaps ? Math.round(gaps.reduce((s, g) => s + gapMinutes(g), 0)) : null;
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
  const omitted = blocks.filter((b) => b.state === 'omitted').length;
  const attentionCount = radar.length;
  const summary = !notionOk
    ? 'No grounded plan is available because Notion task data is missing.'
    : [
        attentionCount ? `${attentionCount} item${attentionCount === 1 ? '' : 's'} need attention.` : 'No deadline warnings right now.',
        topOutcomes[0] ? `Top priority: “${topOutcomes[0].task.title}” (${topOutcomes[0].lane}).` : 'No executable priorities ranked yet.',
        waiting.length ? `${waiting.length} waiting on others — no action from you until they reply.` : '',
        gaps && omitted === 4 ? 'All four blocks omitted because the day is full or sources are partial.' : gaps ? `${scheduled} of 4 blocks fit; ${omitted} skipped.` : '',
        freeMinutes === null ? '' : `${Math.floor(freeMinutes / 60)}h ${freeMinutes % 60}m open between commitments.`
      ]
        .filter(Boolean)
        .join(' ');

  return {
    version: BRIEFING_VERSION,
    date: input.date,
    timezone: zone,
    generatedAt: now.toISOString(),
    status,
    summary,
    sources: {notion: input.notion, calendar: input.calendar},
    warnings,
    topOutcomes,
    blocks,
    radar,
    waiting,
    agentWork,
    tasks: ranked,
    events: calendarOk ? input.events : [],
    capacity: {
      known: calendarOk,
      freeMinutes,
      busyMinutes,
      freeWindows: gaps ? gaps.map((g) => ({start: g.start.toISO()!, end: g.end.toISO()!})) : []
    },
    ai: {status: 'disabled', detail: null},
    plannerVersion: 2,
    planTrace: composed?.trace
  };
}
