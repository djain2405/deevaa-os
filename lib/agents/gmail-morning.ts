import {mergeEmailDigest} from '../briefing-merge';
import {extractDigest} from '../gmail-extract';
import {fetchGmailMessages} from '../google-gmail';
import type {EmailDigest} from '../types';
import type {AgentHandler} from './registry';

export const runGmailMorning: AgentHandler = async ({userId, localDate, runId, now}) => {
  const {messages, health} = await fetchGmailMessages(userId);
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
      warnings: [...health.warnings.map((w) => `Gmail: ${w}`), ...extracted.warnings]
    };
  }
  const row = await mergeEmailDigest(userId, localDate, digest, runId);
  return {briefingId: row.id};
};
