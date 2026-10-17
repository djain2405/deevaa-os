import {z} from 'zod';
import {dueFrom, findDates} from './date-phrases';
import {gmailPermalink, isSkippedCategory, type GmailMessage} from './google-gmail';
import {logEvent} from './log';
import {providerFetch, type FetchOptions} from './provider-fetch';
import {daysUntil} from './time';
import {TIMEZONE, type EmailAction, type EmailDigest, type EmailSummary} from './types';
import {DateTime} from 'luxon';

/** Remaining-work language — not completed payments or order dates. */
export const DEADLINE_RE =
  /\b(due|deadline|expir(?:e|es|ing|ation)|rsvp|reply by|respond by|action required|submit (?:by|before)|payment due)\b/i;
export const ACTION_RE = DEADLINE_RE;
export const MISS_RE =
  /\b(interview|offer letter|visa|contract|tax|irs|verif(?:y|ication)|security alert|password|two-factor|2fa|wire transfer|attorney|court date)\b/i;
export const TRANSACTIONAL_RE =
  /\b(receipt|your (?:order|purchase|payment)|order confirmation|shipping (?:confirmation|update|notification)|has shipped|out for delivery|tracking number|package delivered|delivered to|thanks for your (?:purchase|payment|order)|thank you for your (?:purchase|payment|order)|payment (?:received|processed|confirmed)|we(?:'|’)ve received your (?:order|payment)|purchase confirmation)\b/i;
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

export function isTransactional(text: string) {
  return TRANSACTIONAL_RE.test(text);
}

/** Future or today date next to remaining-work language. Past order/payment dates do not count. */
export function remainingDeadline(text: string, now: Date): string | null {
  if (!DEADLINE_RE.test(text)) return null;
  const today = DateTime.fromJSDate(now).setZone(TIMEZONE).toISODate()!;
  for (const match of findDates(text, now)) {
    const {due} = dueFrom(match);
    const delta = daysUntil(due, today);
    if (delta >= 0 && delta <= 14) return due;
  }
  return null;
}

export function classifyEmail(text: string, now: Date): {kind: 'action' | 'summary' | 'skip'; due: string | null} {
  const transactional = isTransactional(text);
  const due = remainingDeadline(text, now);
  const deadline = DEADLINE_RE.test(text);
  if (transactional && !due) return {kind: 'skip', due: null};
  if (deadline) return {kind: 'action', due};
  if (!transactional && MISS_RE.test(text)) return {kind: 'summary', due: null};
  return {kind: 'skip', due: null};
}

export function extractWithRules(messages: GmailMessage[], now: Date): {actions: EmailAction[]; summaries: EmailSummary[]} {
  const actions: EmailAction[] = [];
  const summaries: EmailSummary[] = [];
  for (const m of messages) {
    if (isSkippedCategory(m.labelIds)) continue;
    const text = messageText(m);
    const classified = classifyEmail(text, now);
    if (NOREPLY.test(m.from) && classified.kind === 'skip') continue;
    const permalink = gmailPermalink(m.threadId);
    const title = (m.subject || m.snippet || 'Message').slice(0, 120);
    if (classified.kind === 'action') {
      actions.push({
        title,
        due: classified.due,
        why: classified.due ? `Remaining deadline ${classified.due} quoted from this message.` : 'Time-sensitive language in this message.',
        permalink,
        evidence: quoteAround(text, DEADLINE_RE)
      });
      continue;
    }
    if (classified.kind === 'summary') {
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
    const classified = classifyEmail(text, now);
    if (classified.kind === 'skip') {
      dropped++;
      continue;
    }
    let due: string | null = classified.due;
    if (item.due) {
      const allowed = findDates(text, now).some((match) => dueFrom(match).due === item.due);
      const candidate = allowed ? item.due : null;
      if (candidate && daysUntil(candidate, today) >= 0 && daysUntil(candidate, today) <= 14) due = candidate;
    }
    if (classified.kind === 'summary' && !due) {
      summaries.push({
        subject: (m.subject || 'Message').slice(0, 120),
        from: displayFrom(m.from),
        why: item.why.slice(0, 300) || 'Important message quoted from the inbox.',
        permalink: gmailPermalink(m.threadId)
      });
      continue;
    }
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
    const text = messageText(m);
    if (classifyEmail(text, now).kind === 'skip') {
      dropped++;
      continue;
    }
    const evidence = groundedQuote(text, item.evidence);
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
  'Ignore receipts, shipping confirmations, and thanks-for-your-payment mail unless a remaining future deadline is quoted.',
  'Do not suggest sending or replying. Do not mark anything done.'
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
