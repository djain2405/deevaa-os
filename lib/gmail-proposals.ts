import type {EmailAction} from './types';
import {createApproval, enqueueAgentRun} from './runtime/store';
import {decideTool} from './runtime/policy';

export function draftReply(action: Pick<EmailAction, 'title' | 'permalink' | 'evidence'>) {
  return {
    action: 'gmail.send' as const,
    send: false as const,
    to: null,
    subject: `Re: ${action.title}`.slice(0, 180),
    body: `Draft only. This was not sent.\n\nQuoted from the message: ${action.evidence}`,
    permalink: action.permalink
  };
}

/** Stores draft replies and task candidates as approvals. Nothing is sent or written to Notion. */
export async function proposeFromDigest(userId: string, localDate: string, actions: EmailAction[]) {
  if (!actions.length) return [];
  const decision = decideTool('gmail.send');
  const run = await enqueueAgentRun({
    userId,
    agentId: 'gmail.morning',
    goal: `Digest proposals ${localDate}`,
    trigger: 'agent',
    idempotencyKey: `gmail-proposals:${userId}:${localDate}`
  });
  const rows = [];
  for (const action of actions.slice(0, 8)) {
    const draft = draftReply(action);
    rows.push(
      await createApproval({
        userId,
        runId: run.run?.id ?? null,
        action: 'gmail.send',
        risk: decision.risk === 'denied' ? 'denied' : 'high',
        payload: draft,
        evidence: action.permalink
      })
    );
    rows.push(
      await createApproval({
        userId,
        runId: run.run?.id ?? null,
        action: 'notion.task.propose',
        risk: 'low',
        payload: {title: action.title, due: action.due, source: action.permalink, apply: false},
        evidence: action.evidence
      })
    );
  }
  return rows;
}
