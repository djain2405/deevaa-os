import {DateTime} from 'luxon';
import {storeKind} from './db/client';
import {PROVIDER} from './google-calendar';
import {notionConfigFromEnv} from './notion';
import {getCredential, latestRun, type BriefingRow, type RunRow} from './store';
import {localDate, tomorrowLocal} from './time';
import type {BriefingSnapshot} from './types';

const STALE_HOURS = 18;

export type Connections = {
  notion: 'configured' | 'not_configured';
  calendar: {state: 'connected' | 'revoked' | 'not_connected'; calendarCount: number; updatedAt: string | null};
  ai: 'enabled' | 'disabled';
  store: 'postgres' | 'embedded';
  scheduler: {lastRunAt: string | null; lastStatus: RunRow['status'] | null};
};

export async function getConnections(userId: string): Promise<Connections> {
  const cfg = notionConfigFromEnv();
  const cred = await getCredential(userId, PROVIDER);
  const tomorrow = await latestRun(userId, tomorrowLocal());
  const today = await latestRun(userId, localDate());
  const cron = [tomorrow, today].find((r) => r?.trigger === 'cron') ?? null;
  return {
    notion: cfg.token && (cfg.dataSourceId || cfg.databaseId) ? 'configured' : 'not_configured',
    calendar: cred
      ? {state: cred.status === 'revoked' ? 'revoked' : 'connected', calendarCount: cred.calendarIds.length, updatedAt: cred.updatedAt.toISOString()}
      : {state: 'not_connected', calendarCount: 0, updatedAt: null},
    ai: process.env.OPENAI_API_KEY ? 'enabled' : 'disabled',
    store: storeKind(),
    scheduler: {lastRunAt: cron?.finishedAt?.toISOString() ?? cron?.startedAt.toISOString() ?? null, lastStatus: cron?.status ?? null}
  };
}

export function freshnessWarnings(snapshot: BriefingSnapshot, run: RunRow | null, now = new Date()) {
  const out: string[] = [];
  const age = DateTime.fromJSDate(now).diff(DateTime.fromISO(snapshot.generatedAt), 'hours').hours;
  if (age > STALE_HOURS) out.push(`This briefing was generated ${Math.floor(age)} hours ago; Notion or your calendar may have changed. Regenerate to refresh.`);
  if (run?.status === 'failed' && run.errorCode === 'source_error') {
    out.push('The latest refresh could not read a source that worked before, so the previous briefing is still shown.');
  } else if (run?.status === 'failed') {
    out.push('The latest refresh failed. The briefing below is from an earlier successful run.');
  }
  return out;
}

export function runView(run: RunRow | null) {
  if (!run) return null;
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    errorCode: run.errorCode,
    attempts: run.attempts,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null
  };
}

export function briefingView(row: BriefingRow | null) {
  if (!row) return null;
  return {...(row.snapshot as BriefingSnapshot), updatedAt: row.updatedAt.toISOString()};
}
