import {dueFrom, findDates} from './date-phrases';
import {item, type Extraction, type ExtractedItem} from './intake-schema';

/** Statements that are examples, conditions or questions. They never create records. */
export const HYPOTHETICAL = /\b(?:if|suppose|supposing|imagine|hypothetically|for example|for instance|e\.g\.|what if|let'?s say|say i|in theory|as an example)\b/i;
/** Future or obligation wording. A status change is never inferred from these. */
export const INTENTION = /\b(?:will|won'?t|going to|gonna|plan(?:ning)? to|need to|have to|has to|should|must|want to|would like to|hope to|try to|about to)\b/i;

const SPLIT =
  /\s*[;—–]\s*|,\s*(?:so|and|but|then|because|also)\s+|,\s*(?=(?:i|i'm|i've|i'll|i'd|my|we)\b)|\s+(?:so|but|and then|and also)\s+(?=(?:i|i'm|i've|i'll|my|we)\b)|\s+and\s+(?=(?:i|i'm|i've|i'll)\b)/i;

const NO_LONGER = /\b(?:i|we)\s+(?:no longer|don'?t|do not)\s+(?:need|have|want)\s+to\s+(.+?)(?:\s+anymore)?$/i;
const NEGATED = /\b(?:don'?t|do not|didn'?t|never|not)\s+(?:need|have|want|plan|going)\b/i;
const BLOCKED = /\b(?:i'?m|i am|we'?re|we are)\s+(?:still\s+)?(?:blocked|stuck)\s+on\s+(.+?)(?:\s+(?:because|until|since)\s+(.+))?$/i;
const WAITING = /\b(?:i'?m|i am|we'?re|we are|still)\s+(?:still\s+|now\s+)?waiting\s+(?:for|on)\s+(.+)$/i;
const SUBMITTED =
  /\b(?:i|we)(?:'ve|\s+have)?\s+(?:already\s+|just\s+|finally\s+)?(submitted|sent|pushed|filed|emailed|applied (?:for|to)|turned in|opened|posted|uploaded|shared)\s+(.+)$/i;
const DONE =
  /\b(?:i|we)(?:'ve|\s+have)?\s+(?:already\s+|just\s+|finally\s+)?(finished|completed|done|wrapped up|paid|booked|rescheduled|canceled|cancelled|fixed|bought|picked up|returned|renewed|cleaned|prepared)\s+(.+)$/i;
const IS_DONE = /^(.+?)\s+(?:is|are)\s+(?:now\s+)?(?:done|finished|complete|completed)\b/i;
const STARTED = /\b(?:i|we)(?:'ve|\s+have)?\s+(?:just\s+)?started\s+(?:working on\s+|on\s+)?(.+)$|\b(?:i'?m|i am)\s+(?:now\s+)?working on\s+(.+)$/i;
const NEED =
  /\b(?:i|we)(?:'ll|'m going to|'m gonna|\s+(?:really\s+|still\s+|also\s+|definitely\s+|probably\s+)?(?:need to|have to|must|should|gotta|got to|ought to|want to|plan to|will|am going to))\s+(?!be\b|have\b)(.+)$|\b(?:remind me to|don'?t forget to|to-?do:?)\s+(.+)$/i;
const GOAL = /\b(?:my goal|goal is|goals? for|i want to become|this quarter|this year|long[- ]term|my (?:top )?priority)\b/i;
const PREFERENCE = /\b(?:i prefer|i'd rather|i would rather|i like to|i don'?t like|i hate|works best for me|i work best|i'?m most productive)\b/i;
const CAPACITY =
  /\b(?:i'?m|i am|feeling|i feel)\s+(?:really\s+|so\s+|pretty\s+|a bit\s+|very\s+)?(?:tired|exhausted|sick|drained|low on energy|low energy|burned out|burnt out|overwhelmed|swamped)\b|\bi only have\s+\d+\s*(?:min|mins|minutes|hours?)\b/i;
const REFLECTION = /\b(?:i learned|lesson learned|i realized|i noticed|next time i|in hindsight)\b/i;
const PERSONAL = /\bmy (?:parents|partner|husband|wife|mom|mother|dad|father|family|kids?|son|daughter|sister|brother|friends?)\b/i;
const PROJECT = /\bfor (?:my |the |our )?([a-z0-9][\w\s-]{1,40}?) project\b/i;
const NEW_PROJECT = /\b(?:new project|starting a project|kicking off|milestone)\b/i;
const DURATION = /\b(?:takes?|take about|about|around|roughly|~)?\s*(\d{1,3})\s*(min|mins|minutes|hour|hours|hr|hrs)\b/i;

function priorityOf(text: string): ExtractedItem['priority'] {
  if (/\b(?:urgent|asap|right away|immediately)\b/i.test(text)) return 'Urgent';
  if (/\b(?:high priority|important|top priority)\b/i.test(text)) return 'High';
  if (/\blow priority\b/i.test(text)) return 'Low';
  return null;
}

function durationOf(text: string) {
  const m = DURATION.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return /^h/i.test(m[2]) ? n * 60 : n;
}

const TRAILING = /\s+(?:today|tonight|tomorrow|this week|next week|soon|asap|right away|again|first|please|as well|too)$/i;

/** Turns a captured clause into a short task title: no dates, no filler, first letter capitalized. */
export function cleanTitle(raw: string, dateTexts: string[] = []) {
  let t = raw.replace(/[\s.!?]+$/, '');
  for (const d of dateTexts) t = t.replace(d, ' ');
  t = t
    .replace(/\b(?:urgent(?:ly)?|asap|high priority|low priority|important)\b/gi, ' ')
    .replace(DURATION, ' ')
    .replace(/\b(?:my|our)\s+/gi, '')
    .replace(/^(?:the\s+)?(?:latest\s+)?(?:changes|updates|fixes|edits|revisions)\s+(?:to|for|on)\s+/i, '')
    .replace(/^(?:to|go|go and|also)\s+/i, '')
    .replace(/\s+(?:which|that) (?:takes|will take).*$/i, '')
    .replace(/\s*,\s*(?:(?:it|this|that|which)(?:'ll| will| should)?)?\s*$/i, '')
    .replace(/\s+,/g, ',')
    .replace(/[\s,.;:!-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  while (TRAILING.test(t)) t = t.replace(TRAILING, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

export function splitSentences(message: string) {
  return message
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Deterministic extraction used when OpenAI is not configured, fails, or returns invalid output. */
export function extractWithRules(message: string, now: Date): Extraction {
  const items: ExtractedItem[] = [];
  let skippedHypothetical = 0;

  for (const sentence of splitSentences(message)) {
    if (/\?\s*$/.test(sentence) || HYPOTHETICAL.test(sentence)) {
      if (HYPOTHETICAL.test(sentence) && (NEED.test(sentence) || DONE.test(sentence))) skippedHypothetical++;
      continue;
    }
    const clauses = sentence.split(SPLIT).map((c) => c.trim()).filter(Boolean);
    const own: ExtractedItem[] = [];
    const constraintDates: ReturnType<typeof findDates> = [];

    for (const clause of clauses) {
      const evidence = clause.replace(/[.!]+$/, '');
      const dates = findDates(clause, now);
      const dateTexts = dates.map((d) => d.text);
      let m: RegExpExecArray | null;

      if ((m = NO_LONGER.exec(clause))) {
        const target = cleanTitle(m[1], dateTexts);
        if (target) own.push(item({kind: 'status_update', title: target, target, evidence, status: 'Canceled', userConfirmed: true}));
        continue;
      }
      if (NEGATED.test(clause)) continue;
      if ((m = BLOCKED.exec(clause))) {
        const target = cleanTitle(m[1], dateTexts);
        if (target) own.push(item({kind: 'status_update', title: target, target, evidence, status: 'Blocked', userConfirmed: true, nextAction: m[2] ? `Blocked: ${m[2].replace(/[.!]+$/, '')}` : null}));
        continue;
      }
      if ((m = WAITING.exec(clause))) {
        const what = m[1].replace(/[.!]+$/, '').trim();
        const prev = own.at(-1);
        if (prev?.kind === 'status_update' && prev.status === 'Waiting') prev.nextAction = `Waiting for ${what}`;
        else {
          const target = cleanTitle(what, dateTexts);
          if (target) own.push(item({kind: 'status_update', title: target, target, evidence, status: 'Waiting', userConfirmed: true, nextAction: `Waiting for ${what}`}));
        }
        continue;
      }
      if ((m = SUBMITTED.exec(clause))) {
        const target = cleanTitle(m[2], dateTexts);
        if (target) {
          own.push(
            item({kind: 'status_update', title: target, target, evidence, status: 'Waiting', userConfirmed: true, nextAction: `You said you ${m[1].toLowerCase()} it; waiting for a response`})
          );
        }
        continue;
      }
      if ((m = DONE.exec(clause)) || (m = IS_DONE.exec(clause))) {
        const target = cleanTitle(m[2] ?? m[1], dateTexts);
        if (target) own.push(item({kind: 'status_update', title: target, target, evidence, status: 'Done', userConfirmed: true}));
        continue;
      }
      if ((m = /^(?!i\b|we\b)(.+?)\s+sent\s+for\s+review\b/i.exec(clause))) {
        const target = cleanTitle(m[1], dateTexts);
        if (target) own.push(item({kind: 'status_update', title: target, target, evidence, status: 'Waiting', userConfirmed: true, nextAction: 'Sent for review — not complete until the reviewer responds'}));
        continue;
      }
      if ((m = /^(?!i\b|we\b)(.+?)\s+(?:was\s+|has been\s+)?submitted\b/i.exec(clause))) {
        const target = cleanTitle(m[1], dateTexts);
        if (target) own.push(item({kind: 'status_update', title: target, target, evidence, status: 'Waiting', userConfirmed: true, nextAction: 'Submitted — waiting on the response, not done'}));
        continue;
      }
      if ((m = /^(?!i\b|we\b)(.+?)\s+can wait\b/i.exec(clause))) {
        const title = cleanTitle(m[1], dateTexts);
        if (title) own.push(item({kind: 'new_task', title, evidence, status: 'Inbox', priority: 'Low', nextAction: 'Can wait'}));
        continue;
      }
      if ((m = STARTED.exec(clause))) {
        const target = cleanTitle(m[1] ?? m[2], dateTexts);
        if (target) own.push(item({kind: 'status_update', title: target, target, evidence, status: 'In Progress', userConfirmed: true}));
        continue;
      }
      if (GOAL.test(clause)) {
        own.push(item({kind: 'goal', title: evidence, evidence}));
        continue;
      }
      if (PREFERENCE.test(clause)) {
        own.push(item({kind: 'preference', title: evidence, evidence}));
        continue;
      }
      if (CAPACITY.test(clause)) {
        own.push(item({kind: 'capacity', title: evidence, evidence}));
        continue;
      }
      if (REFLECTION.test(clause)) {
        own.push(item({kind: 'reflection', title: evidence, evidence}));
        continue;
      }
      if ((m = NEED.exec(clause))) {
        const title = cleanTitle(m[1] ?? m[2], dateTexts);
        if (!title) continue;
        const date = dates.find((d) => d.mode !== 'mention') ?? dates[0];
        const due = date ? dueFrom(date.mode === 'mention' ? {...date, mode: 'on'} : date) : null;
        own.push(
          item({
            kind: 'new_task',
            title,
            evidence,
            status: 'Ready',
            dueText: date?.text ?? null,
            due: due?.due ?? null,
            assumption: due?.assumption ?? null,
            priority: priorityOf(clause),
            durationMinutes: durationOf(clause),
            project: PROJECT.exec(clause)?.[1]?.trim() ?? null
          })
        );
        continue;
      }
      if (NEW_PROJECT.test(clause)) {
        own.push(item({kind: 'project', title: evidence, evidence}));
        continue;
      }
      if (dates.length) {
        own.push(item({kind: 'deadline', title: evidence, evidence, dueText: dates[0].text, due: dates[0].date}));
        constraintDates.push(...dates);
        continue;
      }
      if (PERSONAL.test(clause)) own.push(item({kind: 'personal_context', title: evidence, evidence}));
    }

    // "My parents arrive October 21, so I need to prepare the apartment": the task inherits the stated date.
    if (constraintDates.length === 1) {
      for (const it of own) {
        if (it.kind === 'new_task' && !it.due) {
          const due = dueFrom(constraintDates[0]);
          Object.assign(it, {dueText: constraintDates[0].text, due: due.due, assumption: due.assumption});
        }
      }
    }
    items.push(...own);
  }

  return {
    items: items.slice(0, 12),
    reply: '',
    clarifications: skippedHypothetical ? ['Examples and “if” statements were not saved as tasks.'] : []
  };
}