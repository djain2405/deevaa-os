import {enhanceWithAi} from './ai';
import {blueprintHasContent, parseBlueprint, type Blueprint} from './blueprint';
import {latestBlueprint} from './intake-store';
import {restoreLifeBlueprintFromNotion} from './notion-blueprint';
import {fetchCalendarEvents} from './google-calendar';
import {logEvent} from './log';
import {fetchNotionTasks} from './notion';
import {loadPlannerContext} from './planner/context-load';
import type {PlannerContextExtras} from './planner/snapshot';
import {buildBriefing} from './planner';
import {
  acquireLock,
  audit,
  claimRun,
  finishRun,
  getBriefing,
  releaseLock,
  upsertBriefing,
  type BriefingRow,
  type RunRow
} from './store';
import {BRIEFING_VERSION, type BriefingSnapshot, type CalendarEvent, type SourceHealth, type Task} from './types';

export type BriefingDeps = {
  fetchTasks: () => Promise<{tasks: Task[]; health: SourceHealth}>;
  fetchEvents: (userId: string, date: string) => Promise<{events: CalendarEvent[]; health: SourceHealth}>;
  enhance: (b: BriefingSnapshot) => Promise<BriefingSnapshot>;
  now: () => Date;
  /** Confirmed Life Blueprint only. */
  blueprint?: (userId: string) => Promise<Blueprint | null>;
  plannerContext?: (userId: string, date: string, extras: {blueprint?: Blueprint | null; digest?: BriefingSnapshot['emailDigest']}) => Promise<PlannerContextExtras>;
};

export const defaultDeps: BriefingDeps = {
  fetchTasks: () => fetchNotionTasks(),
  fetchEvents: (userId, date) => fetchCalendarEvents(userId, date),
  enhance: (b) => enhanceWithAi(b),
  now: () => new Date(),
  blueprint: async (userId) => {
    let row = await latestBlueprint(userId);
    const data = row ? parseBlueprint(row.data) : null;
    if (!data || !blueprintHasContent(data)) {
      await restoreLifeBlueprintFromNotion(userId);
      row = await latestBlueprint(userId);
    }
    return row ? parseBlueprint(row.data) : null;
  },
  plannerContext: (userId, date, extras) => loadPlannerContext(userId, date, extras)
};

const LOCK_TTL_MS = 2 * 60 * 1000;

export type RunOutcome = 'created' | 'duplicate' | 'locked' | 'failed' | 'kept_previous';

/** A source that worked last time and fails now must not silently replace the good snapshot. */
function regressed(prev: BriefingRow | null, next: BriefingSnapshot) {
  if (!prev) return false;
  const old = prev.snapshot as BriefingSnapshot;
  return (['notion', 'calendar'] as const).some((k) => old.sources?.[k]?.state === 'connected' && next.sources[k].state === 'error');
}

export async function runBriefing(
  input: {userId: string; date: string; trigger: RunRow['trigger']; idempotencyKey: string},
  deps: BriefingDeps = defaultDeps
): Promise<{outcome: RunOutcome; run: RunRow; briefing: BriefingRow | null}> {
  const claim = await claimRun({userId: input.userId, localDate: input.date, trigger: input.trigger, idempotencyKey: input.idempotencyKey});
  if (claim.outcome === 'duplicate') {
    await audit(input.userId, 'briefing.generate', 'duplicate', {trigger: input.trigger, date: input.date});
    return {outcome: 'duplicate', run: claim.run, briefing: await getBriefing(input.userId, input.date, BRIEFING_VERSION)};
  }

  const lockKey = `briefing:${input.userId}:${input.date}`;
  const owner = await acquireLock(lockKey, LOCK_TTL_MS);
  if (!owner) {
    const run = await finishRun(claim.run.id, {status: 'failed', errorCode: 'locked'});
    return {outcome: 'locked', run, briefing: await getBriefing(input.userId, input.date, BRIEFING_VERSION)};
  }

  try {
    const [notion, calendar, blueprint, previous] = await Promise.all([
      deps.fetchTasks(),
      deps.fetchEvents(input.userId, input.date),
      deps.blueprint ? deps.blueprint(input.userId) : Promise.resolve(null),
      getBriefing(input.userId, input.date, BRIEFING_VERSION)
    ]);
    const previousDigest = previous ? (previous.snapshot as BriefingSnapshot).emailDigest : undefined;
    const context = deps.plannerContext
      ? await deps.plannerContext(input.userId, input.date, {blueprint, digest: previousDigest}).catch(() => null)
      : null;
    const deterministic = buildBriefing({
      date: input.date,
      now: deps.now(),
      tasks: notion.tasks,
      events: calendar.events,
      notion: notion.health,
      calendar: calendar.health,
      blueprint,
      previousDigest: previousDigest ?? null,
      timezone: context?.timezone,
      approvals: context?.approvals,
      feedback: context?.feedback,
      conversation: context?.conversation,
      hasPrivateMaintainSignal: context?.hasPrivateMaintainSignal,
      capacityMode: context?.capacityMode,
      hardStop: context?.hardStop ?? undefined
    });
    const snapshot = await deps.enhance(deterministic).catch(() => ({...deterministic, ai: {status: 'failed' as const, detail: 'AI explanation unavailable; showing the deterministic plan.'}}));

    if (regressed(previous, snapshot)) {
      const run = await finishRun(claim.run.id, {status: 'failed', errorCode: 'source_error'});
      await audit(input.userId, 'briefing.generate', 'error', {trigger: input.trigger, date: input.date, code: 'source_error'});
      return {outcome: 'kept_previous', run, briefing: previous};
    }

    const toStore = previousDigest && !snapshot.emailDigest ? {...snapshot, emailDigest: previousDigest} : snapshot;

    const briefing = await upsertBriefing({
      userId: input.userId,
      localDate: input.date,
      version: BRIEFING_VERSION,
      status: toStore.status,
      snapshot: toStore,
      runId: claim.run.id,
      generatedAt: new Date(toStore.generatedAt)
    });
    const run = await finishRun(claim.run.id, {status: 'succeeded', briefingId: briefing.id});
    await audit(input.userId, 'briefing.generate', 'ok', {trigger: input.trigger, date: input.date, status: snapshot.status, ai: snapshot.ai.status});
    return {outcome: 'created', run, briefing};
  } catch (e) {
    logEvent('error', 'briefing.generate', {kind: e instanceof Error ? e.name : 'unknown'});
    const run = await finishRun(claim.run.id, {status: 'failed', errorCode: 'internal'});
    await audit(input.userId, 'briefing.generate', 'error', {trigger: input.trigger, date: input.date, code: 'internal'});
    return {outcome: 'failed', run, briefing: null};
  } finally {
    await releaseLock(lockKey, owner);
  }
}
