import {getBriefing, upsertBriefing, type BriefingRow} from './store';
import {BRIEFING_VERSION, TIMEZONE, type BriefingSnapshot, type EmailDigest} from './types';

const OMITTED_BLOCKS = (['FOCUS', 'CLOSE', 'MAINTAIN', 'EXPAND'] as const).map((label) => ({
  label,
  state: 'omitted' as const,
  task: null,
  start: null,
  end: null,
  reason: 'No grounded plan is stored yet; only the morning email digest is present.'
}));

const unread = (which: 'notion' | 'calendar') => ({
  state: 'not_connected' as const,
  message: which === 'notion' ? 'Notion was not read for this snapshot.' : 'Google Calendar was not read for this snapshot.',
  lastSyncedAt: null,
  count: 0,
  warnings: []
});

export function emptyDigestBriefing(date: string, now: Date, digest: EmailDigest): BriefingSnapshot {
  return {
    version: BRIEFING_VERSION,
    date,
    timezone: TIMEZONE,
    generatedAt: now.toISOString(),
    status: 'partial',
    summary: 'Email digest is available; the rest of today’s briefing has not been generated yet.',
    sources: {notion: unread('notion'), calendar: unread('calendar')},
    warnings: [
      'This snapshot only includes the morning email digest. Regenerate to load Notion and Calendar.',
      ...digest.warnings
    ],
    topOutcomes: [],
    blocks: OMITTED_BLOCKS,
    tasks: [],
    events: [],
    capacity: {known: false, freeMinutes: null, busyMinutes: null, freeWindows: []},
    ai: {status: 'disabled', detail: null},
    emailDigest: digest
  };
}

const GMAIL_WARNING = /^(Gmail:|This snapshot only includes the morning email digest)/;

export function applyEmailDigest(base: BriefingSnapshot, digest: EmailDigest): BriefingSnapshot {
  const kept = (base.warnings ?? []).filter((w) => !GMAIL_WARNING.test(w));
  const extra = digest.warnings.filter((w) => !kept.includes(w));
  return {
    ...base,
    emailDigest: digest,
    warnings: [...kept, ...extra]
  };
}

export async function mergeEmailDigest(
  userId: string,
  date: string,
  digest: EmailDigest,
  runId: string
): Promise<BriefingRow> {
  const existing = await getBriefing(userId, date, BRIEFING_VERSION);
  const now = new Date(digest.generatedAt);
  const snapshot = existing
    ? applyEmailDigest(existing.snapshot as BriefingSnapshot, digest)
    : emptyDigestBriefing(date, now, digest);
  return upsertBriefing({
    userId,
    localDate: date,
    version: BRIEFING_VERSION,
    status: snapshot.status,
    snapshot,
    runId,
    generatedAt: existing ? existing.generatedAt : now
  });
}
