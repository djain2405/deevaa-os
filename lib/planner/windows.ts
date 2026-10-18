import {DateTime} from 'luxon';
import {TIMEZONE, type CalendarEvent} from '../types';

export const DAY_START = {hour: 7, minute: 0};
export const DAY_END = {hour: 22, minute: 30};
export const PREP_MINUTES = 10;
export const TRANSITION_MINUTES = 10;
export const MIN_GAP = 5;

export type Gap = {start: DateTime; end: DateTime};
export const gapMinutes = (g: Gap) => g.end.diff(g.start, 'minutes').minutes;

export function freeWindows(date: string, events: CalendarEvent[], now: Date, timezone: string = TIMEZONE): Gap[] {
  const zone = timezone || TIMEZONE;
  let start = DateTime.fromISO(date, {zone}).set({hour: DAY_START.hour, minute: DAY_START.minute, second: 0, millisecond: 0});
  const end = DateTime.fromISO(date, {zone}).set({hour: DAY_END.hour, minute: DAY_END.minute, second: 0, millisecond: 0});
  const nowLocal = DateTime.fromJSDate(now).setZone(zone);
  if (nowLocal > start) {
    const rounded = nowLocal.plus({minutes: (5 - (nowLocal.minute % 5)) % 5}).startOf('minute');
    start = rounded > start ? rounded : start;
  }
  if (start >= end) return [];

  const busy = events
    .filter((e) => e.busy && !e.allDay)
    .map((e) => ({
      start: DateTime.fromISO(e.start, {setZone: true}).setZone(zone).minus({minutes: PREP_MINUTES}),
      end: DateTime.fromISO(e.end, {setZone: true}).setZone(zone).plus({minutes: TRANSITION_MINUTES})
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
  return gaps.filter((g) => gapMinutes(g) >= MIN_GAP);
}
