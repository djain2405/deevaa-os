import {findDates} from './date-phrases';
import {SETUP_MINUTES} from './next-action';
import {rankTasks} from './planner';
import {localDate} from './time';
import type {Task} from './types';

export type CosQuery =
  | {kind: 'window'; minutes: number}
  | {kind: 'before'; label: string}
  | {kind: 'delegate'}
  | {kind: 'waiting_on'; person: string};

const PERSONAL = /\b(parent|family|health|therapy|partner|mom|dad)\b/i;

export function matchCosQuery(message: string): CosQuery | null {
  const text = message.trim();
  let m: RegExpExecArray | null;
  if ((m = /\bwhat can i do in\s+(\d{1,3})\s+minutes\b/i.exec(text))) return {kind: 'window', minutes: Number(m[1])};
  if (/\bwhat can i delegate\b/i.test(text)) return {kind: 'delegate'};
  if ((m = /\bwhat(?:'s| is) waiting on\s+([A-Za-z][\w']{1,40})/i.exec(text))) return {kind: 'waiting_on', person: m[1]};
  if ((m = /\bwhat (?:must|should) (?:be done|i do) before\s+(.+?)\??$/i.exec(text))) return {kind: 'before', label: m[1].trim()};
  return null;
}

export function answerCosQuery(query: CosQuery, tasks: Task[], now: Date): {reply: string; clarifications: string[]} {
  const date = localDate(now);
  const ranked = rankTasks(tasks, date, null);
  if (query.kind === 'window') {
    const fits = ranked.filter((t) => t.executable && t.duration !== null && t.duration + SETUP_MINUTES <= query.minutes);
    if (!fits.length) return {reply: `Nothing already estimated at ${query.minutes - SETUP_MINUTES} minutes or less is ready. I did not invent a task.`, clarifications: []};
    return {reply: `In ${query.minutes} minutes, including setup: ${fits.slice(0, 3).map((t) => t.title).join('; ')}.`, clarifications: []};
  }
  if (query.kind === 'delegate') {
    const picks = ranked.filter((t) => t.executable && t.duration !== null && t.duration <= 30 && t.energy !== 'High' && !PERSONAL.test(`${t.title} ${t.project ?? ''}`));
    if (!picks.length) return {reply: 'I do not see a short, non-personal task that is safe to hand off.', clarifications: []};
    return {reply: `Could be delegated after you agree: ${picks.slice(0, 3).map((t) => t.title).join('; ')}. Nothing was assigned.`, clarifications: []};
  }
  if (query.kind === 'waiting_on') {
    const person = query.person.toLowerCase();
    const waiting = tasks.filter((t) => (t.status === 'Waiting' || t.status === 'Waiting for User') && `${t.title} ${t.nextAction ?? ''}`.toLowerCase().includes(person));
    if (!waiting.length) return {reply: `Nothing in Notion is waiting on ${query.person}.`, clarifications: []};
    return {reply: `Waiting on ${query.person}: ${waiting.map((t) => t.title).join('; ')}. Their review is not marked complete.`, clarifications: []};
  }
  const [when] = findDates(query.label, now);
  const arrival = when?.date ?? tasks.find((t) => /parent/i.test(t.title) && t.due)?.due?.slice(0, 10) ?? null;
  if (!arrival) return {reply: 'I need a date before I filter the list.', clarifications: [`When should “${query.label}” count as the deadline?`]};
  const due = tasks.filter((t) => t.status !== 'Done' && t.status !== 'Canceled' && t.due && t.due.slice(0, 10) <= arrival);
  return {reply: `Open tasks due on or before ${arrival}: ${due.length ? due.map((t) => t.title).join('; ') : 'none in Notion.'}`, clarifications: []};
}
