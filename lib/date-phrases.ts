import {DateTime} from 'luxon';
import {TIMEZONE} from './types';

export type DateMode = 'before' | 'by' | 'on' | 'mention';
export type DateMatch = {text: string; date: string; mode: DateMode; index: number};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};
const WEEKDAYS: Record<string, number> = {monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7};

const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const WEEKDAY = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs)?|fri|sat|sun)';
const PREFIX = '(?:(before|by|due|until|no later than|on)\\s+)?';

const PATTERNS: {re: RegExp; resolve: (m: RegExpExecArray, today: DateTime) => DateTime | null}[] = [
  {re: new RegExp(`\\b${PREFIX}(\\d{4})-(\\d{2})-(\\d{2})\\b`, 'gi'), resolve: (m) => DateTime.fromObject({year: +m[2], month: +m[3], day: +m[4]}, {zone: TIMEZONE})},
  {re: new RegExp(`\\b${PREFIX}${MONTH}\\s+${DAY}(?:,?\\s+(\\d{4}))?\\b`, 'gi'), resolve: (m, today) => withYear(today, MONTHS[m[2].toLowerCase()], +m[3], m[4])},
  {re: new RegExp(`\\b${PREFIX}(?:the\\s+)?${DAY}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`, 'gi'), resolve: (m, today) => withYear(today, MONTHS[m[3].toLowerCase()], +m[2], m[4])},
  {re: new RegExp(`\\b${PREFIX}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`, 'gi'), resolve: (m, today) => withYear(today, +m[2], +m[3], m[4])},
  {re: new RegExp(`\\b${PREFIX}(today|tonight|this evening)\\b`, 'gi'), resolve: (_m, today) => today},
  {re: new RegExp(`\\b${PREFIX}(the day after tomorrow)\\b`, 'gi'), resolve: (_m, today) => today.plus({days: 2})},
  {re: new RegExp(`\\b${PREFIX}(tomorrow)\\b`, 'gi'), resolve: (_m, today) => today.plus({days: 1})},
  {re: new RegExp(`\\b${PREFIX}in\\s+(\\d{1,2}|a|one|two|three)\\s+(days?|weeks?)\\b`, 'gi'), resolve: (m, today) => {
    const n = ({a: 1, one: 1, two: 2, three: 3} as Record<string, number>)[m[2].toLowerCase()] ?? +m[2];
    return today.plus(m[3].toLowerCase().startsWith('week') ? {weeks: n} : {days: n});
  }},
  {re: new RegExp(`\\b${PREFIX}(next|this|coming)?\\s*${WEEKDAY}\\b`, 'gi'), resolve: (m, today) => {
    const target = WEEKDAYS[m[3].toLowerCase()];
    let add = (target - today.weekday + 7) % 7;
    if (m[2]?.toLowerCase() === 'next' && add === 0) add = 7;
    return today.plus({days: add});
  }}
];

function withYear(today: DateTime, month: number | undefined, day: number, year?: string) {
  if (!month || day < 1 || day > 31) return null;
  if (year) return DateTime.fromObject({year: year.length === 2 ? 2000 + +year : +year, month, day}, {zone: TIMEZONE});
  const d = DateTime.fromObject({year: today.year, month, day}, {zone: TIMEZONE});
  return d < today.minus({days: 60}) ? d.plus({years: 1}) : d;
}

const modeOf = (word: string | undefined): DateMode => {
  const w = word?.toLowerCase();
  if (w === 'before') return 'before';
  if (w === 'by' || w === 'due' || w === 'until' || w === 'no later than') return 'by';
  if (w === 'on') return 'on';
  return 'mention';
};

/** Finds explicit and relative dates, resolved against the message time in America/Los_Angeles. */
export function findDates(text: string, now: Date): DateMatch[] {
  const today = DateTime.fromJSDate(now).setZone(TIMEZONE).startOf('day');
  const found: DateMatch[] = [];
  const taken: [number, number][] = [];
  for (const {re, resolve} of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      const d = resolve(m, today);
      if (!d?.isValid) continue;
      taken.push([start, end]);
      found.push({text: m[0].trim(), date: d.toISODate()!, mode: modeOf(m[1]), index: start});
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** The due date implied by a phrase. "Before X" means the day before X, reported as an assumption. */
export function dueFrom(match: DateMatch): {due: string; assumption: string | null} {
  if (match.mode === 'before') {
    const due = DateTime.fromISO(match.date, {zone: TIMEZONE}).minus({days: 1}).toISODate()!;
    return {due, assumption: `“${match.text}” was read as due ${due}.`};
  }
  if (match.mode === 'mention') return {due: match.date, assumption: `Due set to the date you mentioned (${match.date}); change it if it must be done earlier.`};
  return {due: match.date, assumption: null};
}
