import {DateTime} from 'luxon';
import {TIMEZONE} from './types';

export function localDate(now: Date = new Date()) {
  return DateTime.fromJSDate(now).setZone(TIMEZONE).toISODate()!;
}

export function tomorrowLocal(now: Date = new Date()) {
  return DateTime.fromJSDate(now).setZone(TIMEZONE).plus({days: 1}).toISODate()!;
}

export function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value, {zone: TIMEZONE}).isValid;
}

/** Start and exclusive end of a local calendar day. 23 or 25 hours long on DST transition days. */
export function dayBounds(date: string) {
  const start = DateTime.fromISO(date, {zone: TIMEZONE}).startOf('day');
  return {start, end: start.plus({days: 1})};
}

export function atLocal(date: string, hour: number, minute = 0) {
  return DateTime.fromISO(date, {zone: TIMEZONE}).set({hour, minute, second: 0, millisecond: 0});
}

export function parseEventTime(value: {dateTime?: string; date?: string} | undefined) {
  if (value?.dateTime) return {time: DateTime.fromISO(value.dateTime, {setZone: true}).setZone(TIMEZONE), allDay: false};
  if (value?.date) return {time: DateTime.fromISO(value.date, {zone: TIMEZONE}).startOf('day'), allDay: true};
  return null;
}

/** Days from `date` to a Notion due value (date or datetime), compared as local calendar dates. */
export function daysUntil(due: string, date: string) {
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(due)
    ? DateTime.fromISO(due, {zone: TIMEZONE})
    : DateTime.fromISO(due, {setZone: true}).setZone(TIMEZONE).startOf('day');
  return Math.round(dueDate.diff(DateTime.fromISO(date, {zone: TIMEZONE}), 'days').days);
}

export function formatLocalTime(iso: string) {
  return DateTime.fromISO(iso, {setZone: true}).setZone(TIMEZONE).toFormat('h:mm a');
}
