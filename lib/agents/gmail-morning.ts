import {mergeEmailDigest} from '../briefing-merge';
import {bucketCounts, extractDigest} from '../gmail-extract';
import {proposeFromDigest} from '../gmail-proposals';
import {fetchGmailMessages} from '../google-gmail';
import {logEvent} from '../log';
import type {EmailDigest} from '../types';
import type {AgentHandler} from './registry';

export const runGmailMorning: AgentHandler = async ({userId, localDate, runId, now, dryRun}) => {
  const {messages, unseenIds, health} = await fetchGmailMessages(userId);
  const generatedAt = now.toISOString();
  let digest: EmailDigest;
  if (health.state !== 'connected') {
    digest = {
      status: 'unavailable',
      generatedAt,
      actions: [],
      summaries: [],
      warnings: [`Gmail: ${health.message}`]
    };
  } else {
    const extracted = await extractDigest(messages, now);
    digest = {
      status: health.warnings.length || extracted.warnings.length ? 'partial' : 'complete',
      generatedAt,
      actions: extracted.actions,
      summaries: extracted.summaries,
      warnings: [...health.warnings.map((w) => `Gmail: ${w}`), ...extracted.warnings],
      buckets: bucketCounts(extracted.actions, extracted.summaries)
    };
  }
  if (dryRun) {
    logEvent('info', 'gmail.morning.dry_run', {actions: digest.actions.length, status: digest.status});
    return {};
  }
  if (health.state === 'connected' && digest.actions.length) {
    await proposeFromDigest(userId, localDate, digest.actions, unseenIds);
  }
  const row = await mergeEmailDigest(userId, localDate, digest, runId);
  return {briefingId: row.id};
};
