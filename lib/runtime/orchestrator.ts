import {acquireLock, releaseLock} from '../store';
import {createHandoff} from './store';
import {inQuietHours} from '../settings';

export type Assignment = {agentId: string; taskId: string; reason: string};

export function findClaimConflicts(claims: {agentId: string; taskId: string}[]) {
  const byTask = new Map<string, string[]>();
  for (const claim of claims) {
    const list = byTask.get(claim.taskId) ?? [];
    list.push(claim.agentId);
    byTask.set(claim.taskId, list);
  }
  return [...byTask.entries()].filter(([, agents]) => new Set(agents).size > 1).map(([taskId, agents]) => ({taskId, agents}));
}

/** Assigns at most one agent per task. High-impact external work is returned as an approval, not executed. */
export async function coordinate(input: {
  userId: string;
  now: Date;
  settings: {timezone: string; quietStart: string; quietEnd: string};
  tasks: {id: string; title: string; urgent: boolean; personal: boolean}[];
  fromRunId?: string | null;
}) {
  if (inQuietHours(input.settings, input.now)) return {outcome: 'quiet' as const, assignments: [] as Assignment[], approvals: [] as string[], conflicts: []};
  const assignments: Assignment[] = [];
  const approvals: string[] = [];
  for (const task of input.tasks) {
    const agentId = task.personal ? 'life.ops' : task.urgent ? 'project.manager' : 'chief.of.staff';
    const lock = await acquireLock(`task:${input.userId}:${task.id}`, 15000);
    if (!lock) {
      assignments.push({agentId, taskId: task.id, reason: 'locked'});
      continue;
    }
    assignments.push({agentId, taskId: task.id, reason: task.urgent ? 'urgent' : 'routine'});
    await releaseLock(`task:${input.userId}:${task.id}`, lock);
  }
  const conflicts = findClaimConflicts(assignments.filter((a) => a.reason !== 'locked'));
  const essential = input.tasks.filter((t) => t.urgent && !t.personal);
  if (essential.length && input.fromRunId !== undefined) {
    const handoff = await createHandoff({
      userId: input.userId,
      fromRunId: input.fromRunId ?? null,
      toAgentId: 'project.manager',
      payload: {taskIds: essential.map((t) => t.id), approvalRequired: true}
    });
    approvals.push(handoff.id);
  }
  return {outcome: 'coordinated' as const, assignments, approvals, conflicts};
}
