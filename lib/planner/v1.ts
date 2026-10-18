import {DateTime} from 'luxon';
import {logEvent} from '../log';
import {formatLocalTime} from '../time';
import {BLOCK_ROLE, type Block, type Interval, type RankedTask} from '../types';
import {TRANSITION_MINUTES} from './windows';

export const UNKNOWN_FOCUS_MINUTES = 45;
export const MAX_FOCUS_MINUTES = 90;
export const FOCUS_MIN = 25;
export const CLOSE_MAX = 15;
export const EXPAND_MINUTES = 30;
export const MAX_PLANNED_SHARE = 0.7;
export const MAINTAIN_PATTERN = /\b(home|health|fitness|gym|meal|cook|groceries|laundry|clean|tidy|appointment|doctor|dentist|walk|exercise|sleep|rest)\b/i;
const MIN_GAP = 5;

export type Gap = {start: DateTime; end: DateTime};
export const gapMinutes = (g: Gap) => g.end.diff(g.start, 'minutes').minutes;

export class Allocator {
  private planned = 0;
  constructor(
    private gaps: Gap[],
    private budget: number
  ) {}
  hasSpace(length: number) {
    return this.gaps.some((g) => gapMinutes(g) >= length);
  }
  place(length: number): Interval | null {
    if (this.planned > 0 && this.planned + length > this.budget) return null;
    const gap = this.gaps.find((g) => gapMinutes(g) >= length);
    if (!gap) return null;
    const slot = {start: gap.start, end: gap.start.plus({minutes: length})};
    gap.start = slot.end.plus({minutes: TRANSITION_MINUTES});
    this.gaps = this.gaps.filter((g) => gapMinutes(g) >= MIN_GAP);
    this.planned += length;
    return {start: slot.start.toISO()!, end: slot.end.toISO()!};
  }
}

const windowLabel = (slot: Interval) => `${formatLocalTime(slot.start)}–${formatLocalTime(slot.end)}`;

export function auditV1(ranked: RankedTask[]) {
  const ready = ranked.filter((t) => t.executable && t.lane !== 'Verify');
  const rejections: Record<string, number> = {
    no_duration: 0,
    duration_too_long: 0,
    not_home_or_pattern: 0,
    used_by_focus: 0,
    expand_never_assigns: ready.length
  };
  for (const t of ready) {
    if (t.duration === null) rejections.no_duration++;
    else if (t.duration > CLOSE_MAX) rejections.duration_too_long++;
    if (t.duration === null || !(t.context === 'Home' || MAINTAIN_PATTERN.test(t.title))) rejections.not_home_or_pattern++;
  }
  const closePool = ready.filter((t) => t.duration !== null && t.duration <= CLOSE_MAX).length;
  const maintainPool = ready.filter((t) => t.duration !== null && (t.context === 'Home' || MAINTAIN_PATTERN.test(t.title))).length;
  logEvent('info', 'planner.v1.audit', {
    readyCount: ready.length,
    closePool,
    maintainPool,
    expandAssigned: 0,
    ...rejections
  });
  return {readyCount: ready.length, closePool, maintainPool, rejections};
}

export function planBlocksV1(ranked: RankedTask[], gaps: Gap[] | null, opts: {maxShare?: number; toRef: (t: RankedTask) => import('../types').TaskRef}): Block[] {
  const toRef = opts.toRef;
  const ready = ranked.filter((t) => t.executable && t.lane !== 'Verify');
  const used = new Set<string>();
  const freeTotal = gaps ? gaps.reduce((s, g) => s + gapMinutes(g), 0) : 0;
  const alloc = gaps ? new Allocator(gaps.map((g) => ({...g})), Math.floor(freeTotal * (opts?.maxShare ?? MAX_PLANNED_SHARE))) : null;
  const noCalendar = 'Calendar not connected, so no time window is claimed.';
  auditV1(ranked);

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
        return {label, state: 'scheduled', task: toRef(t), start: slot.start, end: slot.end, reason: `${why} Open ${windowLabel(slot)}.${unknown}`};
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
      ? {label: 'EXPAND', state: 'scheduled', task: null, start: slot.start, end: slot.end, reason: `Reserved for people, learning, connection or creativity. No task is assigned on purpose. Open ${windowLabel(slot)}.`}
      : {
          label: 'EXPAND',
          state: 'omitted',
          task: null,
          start: null,
          end: null,
          reason: alloc.hasSpace(EXPAND_MINUTES) ? 'Skipped to keep slack in an already full day.' : 'Not enough open time left; skipped rather than overbooking the day.'
        };
  }
  return [focus, close, maintain, expand].map((block) => ({...block, role: BLOCK_ROLE[block.label]}));
}
