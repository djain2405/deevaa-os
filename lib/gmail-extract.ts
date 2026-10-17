import {z} from 'zod';
import {dueFrom, findDates} from './date-phrases';
import {gmailPermalink, isSkippedCategory, type GmailMessage} from './google-gmail';
import {logEvent} from './log';
import {providerFetch, type FetchOptions} from './provider-fetch';
import {daysUntil} from './time';
import {TIMEZONE, type EmailAction, type EmailDigest, type EmailSummary} from './types';
import {DateTime} from 'luxon';

export const ACTION_RE =
  /\b(due|deadline|expir(?:e|es|ing|ed|ation)|rsvp|invoice|pay(?:ment)?|submit|asap|urgent|reply by|respond by|action required)\b/i;
export const MISS_RE =
  /\b(interview|offer letter|visa|contract|tax|irs|verif(?:y|ication)|security alert|password|two-factor|2fa|wire transfer|attorney|court date)\b/i;
const NOREPLY = /no-?reply|mailer-daemon|notifications@|newsletter|donotreply/i;
const normalize = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

const ModelDigest = z.object({
  actions: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        due: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]),
        why: z.string().max(300),
        evidence: z.string().min(1).max(200),
        messageId: z.string().min(1)
      })
    )
    .max(20),
  summaries: z
    .array(
      z.object({
        why: z.string().max(300),
        evidence: z.string().min(1).max(200),
        messageId: z.string().min(1)
      })
    )
    .max(20)
});

export function messageText(m: GmailMessage) {
  return `${m.subject}\n${m.from}\n${m.snippet}\n${m.excerpt}`;
}

function displayFrom(from: string) {
  const named = from.match(/^\s*"?([^"<]+?)"?\s*</);
  if (named?.[1]) return named[1].trim().slice(0, 80);
  return from.replace(/[<>]/g, '').trim().slice(0, 80) || 'Unknown sender';
}

function quoteAround(text: string, re: RegExp) {
  const m = re.exec(text);
  const slice = m
    ? text.slice(Math.max(0, m.index - 16), Math.min(text.length, m.index + m[0].length + 48))
    : text.slice(0, 80);
  return slice.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function groundedQuote(text: string, evidence: string) {
  const hay = normalize(text);
  const needle = normalize(evidence);
  if (!needle || !hay.includes(needle)) return null;
  return evidence.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function dueFromText(text: string, now: Date, today: string): string | null {
  const matches = findDates(text, now);
  for (const match of matches) {
    const {due} = dueFrom(match);
    const delta = daysUntil(due, today);
    if (delta >= -1 && delta <= 7) return due;
  }
  return matches[0] ? dueFrom(matches[0]).due : null;
}

export function extractWithRules(messages: GmailMessage[], now: Date): {actions: EmailAction[]; summaries: EmailSummary[]} {
  const today = DateTime.fromJSDate(now).setZone(TIMEZONE).toISODate()!;
  const actions: EmailAction[] = [];
  const summaries: EmailSummary[] = [];
  for (const m of messages) {
    if (isSkippedCategory(m.labelIds)) continue;
    const text = messageText(m);
    const actionHit = ACTION_RE.test(text);
    const missHit = MISS_RE.test(text);
    if (NOREPLY.test(m.from) && !actionHit && !missHit) continue;
    const due = actionHit || findDates(text, now).length ? dueFromText(text, now, today) : null;
    const near = due ? daysUntil(due, today) <= 7 && daysUntil(due, today) >= -1 : false;
    const permalink = gmailPermalink(m.threadId);
    const title = (m.subject || m.snippet || 'Message').slice(0, 120);
    if (actionHit || near) {
      actions.push({
        title,
        due: near ? due : null,
        why: actionHit ? 'Time-sensitive language in this message.' : `A date in the next few days is mentioned (${due}).`,
        permalink,
        evidence: quoteAround(text, actionHit ? ACTION_RE : /\d/)
      });
      continue;
    }
    if (missHit) {
      summaries.push({
        subject: title,
        from: displayFrom(m.from),
        why: 'Flagged as easy to miss (verification, offer, or similar).',
        permalink
      });
    }
  }
  return {actions: actions.slice(0, 12), summaries: summaries.slice(0, 12)};
}

function byId(messages: GmailMessage[]) {
  return new Map(messages.map((m) => [m.id, m]));
}

export function groundModelOutput(
  raw: unknown,
  messages: GmailMessage[],
  now: Date
): {actions: EmailAction[]; summaries: EmailSummary[]; dropped: number} {
  const parsed = ModelDigest.safeParse(raw);
  if (!parsed.success) return {actions: [], summaries: [], dropped: -1};
  const today = DateTime.fromJSDate(now).setZone(TIMEZONE).toISODate()!;
  const lookup = byId(messages);
  const actions: EmailAction[] = [];
  const summaries: EmailSummary[] = [];
  let dropped = 0;
  for (const item of parsed.data.actions) {
    const m = lookup.get(item.messageId);
    if (!m) {
      dropped++;
      continue;
    }
    const text = messageText(m);
    const evidence = groundedQuote(text, item.evidence);
    if (!evidence) {
      dropped++;
      continue;
    }
    let due: string | null = null;
    if (item.due) {
      const allowed = findDates(text, now).some((match) => dueFrom(match).due === item.due);
      due = allowed ? item.due : null;
    }
    if (due && daysUntil(due, today) > 14) due = null;
    actions.push({
      title: (item.title || m.subject || 'Message').slice(0, 120),
      due,
      why: item.why.slice(0, 300) || 'Time-sensitive item quoted from this message.',
      permalink: gmailPermalink(m.threadId),
      evidence
    });
  }
  for (const item of parsed.data.summaries) {
    const m = lookup.get(item.messageId);
    if (!m) {
      dropped++;
      continue;
    }
    const evidence = groundedQuote(messageText(m), item.evidence);
    if (!evidence) {
      dropped++;
      continue;
    }
    summaries.push({
      subject: (m.subject || 'Message').slice(0, 120),
      from: displayFrom(m.from),
      why: item.why.slice(0, 300) || 'Important message quoted from the inbox.',
      permalink: gmailPermalink(m.threadId)
    });
  }
  return {actions: actions.slice(0, 12), summaries: summaries.slice(0, 12), dropped};
}

function mergeUnique(rules: {actions: EmailAction[]; summaries: EmailSummary[]}, model: {actions: EmailAction[]; summaries: EmailSummary[]}) {
  const actionKeys = new Set(rules.actions.map((a) => a.permalink));
  const summaryKeys = new Set(rules.summaries.map((s) => s.permalink));
  return {
    actions: [...rules.actions, ...model.actions.filter((a) => !actionKeys.has(a.permalink))].slice(0, 12),
    summaries: [...rules.summaries, ...model.summaries.filter((s) => !summaryKeys.has(s.permalink))].slice(0, 12)
  };
}

const SYSTEM = [
  'You extract time-sensitive actions and easy-to-miss notes from inbox messages for a personal briefing.',
  'Return JSON only: {"actions": Action[], "summaries": Summary[]}.',
  'Action: title, due (YYYY-MM-DD or null), why, evidence, messageId.',
  'Summary: why, evidence, messageId.',
  'evidence must be copied exactly from that message. Never invent dates. Ignore promotions, social mail, and newsletters.',
  'Do not suggest sending, replying, or creating tasks. Do not mark anything done.'
].join('\n');

export async function extractDigest(
  messages: GmailMessage[],
  now: Date,
  opts: FetchOptions & {apiKey?: string; model?: string} = {}
): Promise<Pick<EmailDigest, 'actions' | 'summaries' | 'warnings'>> {
  const rules = extractWithRules(messages, now);
  const warnings: string[] = [];
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey || messages.length === 0) return {...rules, warnings};
  try {
    const local = DateTime.fromJSDate(now).setZone(TIMEZONE);
    const payload = messages.map((m) => ({
      messageId: m.id,
      subject: m.subject,
      from: displayFrom(m.from),
      text: messageText(m).slice(0, 800)
    }));
    const res = await providerFetch(
      'openai.gmail',
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({
          model: opts.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
          temperature: 0,
          response_format: {type: 'json_object'},
          messages: [
            {role: 'system', content: SYSTEM},
            {
              role: 'user',
              content: `Current time: ${local.toISO()} (${TIMEZONE}).\n<messages>\n${JSON.stringify(payload)}\n</messages>`
            }
          ]
        })
      },
      {retries: 1, timeoutMs: 20000, ...opts}
    );
    if (!res.ok) {
      warnings.push('Optional AI extraction was unavailable; the digest used built-in rules.');
      return {...rules, warnings};
    }
    const body = await res.json();
    let json: unknown;
    try {
      json = JSON.parse(body?.choices?.[0]?.message?.content ?? '');
    } catch {
      warnings.push('Optional AI extraction returned invalid JSON and was ignored.');
      return {...rules, warnings};
    }
    const grounded = groundModelOutput(json, messages, now);
    if (grounded.dropped === -1) {
      logEvent('warn', 'ai.gmail.rejected', {reason: 'schema'});
      warnings.push('Optional AI extraction did not match the required format and was ignored.');
      return {...rules, warnings};
    }
    return {...mergeUnique(rules, grounded), warnings};
  } catch {
    warnings.push('Optional AI extraction was unavailable; the digest used built-in rules.');
    return {...rules, warnings};
  }
}
