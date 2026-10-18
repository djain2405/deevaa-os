import {listMessages, listOps, recentFeedback} from '../intake-store';
import {listMemory} from '../memory';
import {listApprovals} from '../runtime/store';
import {getSettings} from '../settings';
import {projectConversation} from './conversation-state';
import {inferCapacityMode, inferHardStop, type PlannerContextExtras} from './snapshot';
import type {Blueprint} from '../blueprint';
import type {EmailDigest} from '../types';

export async function loadPlannerContext(
  userId: string,
  date: string,
  extras: {blueprint?: Blueprint | null; digest?: EmailDigest | null} = {}
): Promise<PlannerContextExtras> {
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000);
  const [settings, messages, ops, approvals, feedback, memory] = await Promise.all([
    getSettings(userId).catch(() => null),
    listMessages(userId, 40).catch(() => []),
    listOps(userId, 40).catch(() => []),
    listApprovals(userId).catch(() => []),
    recentFeedback(userId, since).catch(() => []),
    listMemory(userId).catch(() => [])
  ]);
  const conversation = projectConversation({
    messages: messages.map((m) => ({role: m.role, result: m.result})),
    ops: ops.map((op) => ({kind: op.kind, status: op.status, title: op.title, pageId: op.pageId, fields: op.fields, opKey: op.opKey}))
  });
  return {
    timezone: settings?.timezone,
    digest: extras.digest ?? null,
    approvals: approvals.filter((a) => a.status === 'pending').map((a) => ({id: a.id, action: a.action, risk: a.risk, status: a.status})),
    feedback: feedback.map((f) => ({taskId: f.taskId, kind: f.kind, createdAt: f.createdAt.toISOString(), context: f.context})),
    conversation,
    hasPrivateMaintainSignal: memory.some((row) => row.partition === 'reflection' || row.consent === 'private'),
    capacityMode: inferCapacityMode({blueprint: extras.blueprint, conversation}),
    hardStop: inferHardStop(date, settings)
  };
}
