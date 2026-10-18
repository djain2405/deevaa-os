import {DateTime} from 'luxon';
import type {CalendarEvent, Task} from './types';

export type PrepProposal = {title: string; due: string | null; reason: string; eventId: string; write: false};
export type Conflict = {eventIds: string[]; reason: string};

export function calendarConflicts(events: CalendarEvent[]): Conflict[] {
  const busy = events.filter((e) => e.busy && !e.allDay).sort((a, b) => a.start.localeCompare(b.start));
  const out: Conflict[] = [];
  for (let i = 0; i < busy.length; i++) {
    for (let j = i + 1; j < busy.length; j++) {
      if (busy[j].start >= busy[i].end) break;
      out.push({eventIds: [busy[i].id, busy[j].id], reason: `“${busy[i].title}” overlaps “${busy[j].title}”.`});
    }
  }
  return out;
}

/** Preparation tasks are proposals. Travel time is not invented when the event has no travel field. */
export function prepProposals(events: CalendarEvent[], now: Date): PrepProposal[] {
  const horizon = DateTime.fromJSDate(now).plus({days: 7}).toMillis();
  return events
    .filter((e) => !e.allDay && Date.parse(e.start) >= now.getTime() && Date.parse(e.start) <= horizon)
    .filter((e) => /\b(interview|talk|flight|workshop|review|hearing)\b/i.test(e.title))
    .map((e) => ({
      title: `Prepare for ${e.title}`.slice(0, 160),
      due: e.start.slice(0, 10),
      reason: 'Suggested from the event title. No travel time was added.',
      eventId: e.id,
      write: false as const
    }));
}

export function tentativeEvents(events: (CalendarEvent & {tentative?: boolean})[]) {
  return events.filter((e) => e.tentative);
}

export function tasksBefore(tasks: Task[], day: string) {
  return tasks.filter((t) => t.status !== 'Done' && t.status !== 'Canceled' && t.due && t.due.slice(0, 10) <= day);
}
