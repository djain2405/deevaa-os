import {dice} from '../intake-match';
import {contextForAgent} from '../memory';
import {decideTool} from '../runtime/policy';
import {createApproval, enqueueAgentRun, finishAgentRun} from '../runtime/store';
import {markAwaitingApproval} from '../runtime/worker';
import {getSettings, inQuietHours} from '../settings';
import type {Task} from '../types';

export type SpecialistResult = {summary: string; artifacts: unknown[]; approvals: string[]; taskIds: string[]};

const LEGAL = /\b(you qualify|eligible for eb-?1a|will be approved|as a matter of law)\b/i;

export function projectSweep(tasks: Task[]) {
  const open = tasks.filter((t) => t.status !== 'Done' && t.status !== 'Canceled');
  const blockers = open.filter((t) => t.status === 'Blocked' || t.blocker);
  const stale = open.filter((t) => t.status === 'Waiting');
  const proposed = open
    .filter((t) => !t.nextAction && t.status === 'Ready')
    .filter((t, i, all) => all.findIndex((o) => dice(o.title, t.title) >= 0.75) === i);
  return {
    summary: `${open.length} open, ${blockers.length} blocked, ${stale.length} waiting, ${proposed.length} missing a next action.`,
    blockers: blockers.map((t) => t.id),
    nextActions: proposed.map((t) => ({taskId: t.id, title: t.title, suggestion: `Next: define the next physical step for “${t.title}”.`}))
  };
}

export function contributionCandidate(input: {repo: string; issue: string; summary: string}) {
  const branch = `deevaa/contrib-${input.repo.replace(/[^\w]+/g, '-').slice(0, 40)}`;
  return {
    repo: input.repo,
    issue: input.issue,
    branch,
    isolation: 'worktree',
    plan: input.summary,
    tests: ['lint', 'typecheck', 'unit'],
    merge: 'denied' as const,
    publish: 'approval' as const
  };
}

export function opportunityBrief(sources: {title: string; url: string; deadline: string | null; excerpt: string}[]) {
  const kept = sources.filter((s) => /^https:\/\//.test(s.url) && s.excerpt.trim().length > 0);
  return {
    summary: kept.length ? `${kept.length} sourced opportunity(s).` : 'No source with a citation was available, so nothing was recommended.',
    items: kept.map((s) => ({title: s.title, url: s.url, deadline: s.deadline, citation: s.excerpt.slice(0, 240)}))
  };
}

export function consultancyDraft(input: {packageName: string; audience: string; notes: string[]}) {
  const safe = input.notes.filter((n) => !/therapy|diagnosis|journal/i.test(n));
  return {
    summary: `Draft for ${input.packageName}. Not sent.`,
    audience: input.audience,
    constraints: ['Employer policy, confidentiality, IP, and work authorization need a manual check before any outreach.'],
    notes: safe,
    send: false
  };
}

export function evidencePacket(items: {title: string; status: 'outstanding' | 'sent_for_review' | 'received'; source: string; date: string | null}[]) {
  const narrative = 'This packet lists documents and dates only. It does not judge eligibility.';
  if (LEGAL.test(narrative)) throw new Error('legal claim');
  return {summary: narrative, outstanding: items.filter((i) => i.status === 'outstanding'), sentForReview: items.filter((i) => i.status === 'sent_for_review'), received: items.filter((i) => i.status === 'received')};
}

export function arrivalChecklist(tasks: Task[], arriveOn: string) {
  const related = tasks.filter((t) => t.due && t.due.slice(0, 10) <= arriveOn && /parent|apartment|guest|airport|clean|shop/i.test(`${t.title} ${t.project ?? ''}`));
  const done = related.filter((t) => t.status === 'Done').map((t) => t.title);
  const open = related.filter((t) => t.status !== 'Done' && t.status !== 'Canceled');
  const blockers = open.filter((t) => t.status === 'Blocked' || t.blocker).map((t) => ({title: t.title, blocker: t.blocker}));
  const gaps = /apartment|clean|guest/.test(open.concat(related).map((t) => t.title).join(' ')) ? [] : ['No apartment-prep task is on the list yet.'];
  return {summary: `${done.length} done, ${open.length} open before ${arriveOn}.`, done, open: open.map((t) => t.title), blockers, gaps};
}

export async function runSpecialist(userId: string, agentId: string, now: Date, tasks: Task[] = []): Promise<{outcome: string; result?: SpecialistResult}> {
  const settings = await getSettings(userId);
  if (settings.pauseAll) return {outcome: 'paused'};
  if (settings.maintenanceMode) return {outcome: 'maintenance'};
  if (inQuietHours(settings, now)) return {outcome: 'quiet'};
  const budget = settings.agentBudgets?.[agentId];
  if (budget === 0) return {outcome: 'budget'};
  const known = ['project.manager', 'open.source', 'gde.research', 'consultancy', 'eb1a', 'life.ops'];
  if (!known.includes(agentId)) return {outcome: 'unknown'};
  const queued = await enqueueAgentRun({userId, agentId, goal: agentId, trigger: 'manual', idempotencyKey: `${agentId}:${userId}:${now.toISOString()}`});
  const run = queued.run;
  if (!run) return {outcome: 'failed'};
  if (queued.outcome === 'duplicate' && run.status === 'completed') return {outcome: 'duplicate'};

  let artifacts: unknown[] = [];
  let summary = '';
  const approvals: string[] = [];
  if (agentId === 'project.manager') {
    const sweep = projectSweep(tasks);
    summary = sweep.summary;
    artifacts = [sweep];
  } else if (agentId === 'open.source') {
    const candidate = contributionCandidate({repo: 'example/android-samples', issue: '123', summary: 'Reproduce the bug, add a regression test, and keep the change scoped to that issue.'});
    summary = `Prepared ${candidate.branch}. A public pull request is waiting for approval.`;
    artifacts = [candidate];
    const gate = decideTool('github.pr.open');
    const row = await createApproval({userId, runId: run.id, action: 'github.pr.open', risk: 'high', payload: candidate, evidence: candidate.issue});
    approvals.push(row.id);
    await markAwaitingApproval(run.id);
    if (gate.decision === 'deny') return {outcome: 'denied'};
  } else if (agentId === 'gde.research') {
    const brief = opportunityBrief([{title: 'On-device AI summit CFP', url: 'https://example.com/cfp', deadline: null, excerpt: 'Call for talks on mobile and on-device AI.'}]);
    summary = brief.summary;
    artifacts = [brief];
  } else if (agentId === 'consultancy') {
    const memory = await contextForAgent(userId, 'consultancy');
    const draft = consultancyDraft({packageName: 'Mobile + AI engineering', audience: 'Series B product teams', notes: memory.map((m) => m.body)});
    summary = draft.summary;
    artifacts = [draft];
    const row = await createApproval({userId, runId: run.id, action: 'outreach.send', risk: 'high', payload: {...draft, send: false}, evidence: 'draft'});
    approvals.push(row.id);
  } else if (agentId === 'eb1a') {
    const packet = evidencePacket(tasks.filter((t) => /eb-?1a|letter|talk|award/i.test(`${t.title} ${t.project ?? ''}`)).map((t) => ({title: t.title, status: t.status === 'Waiting' ? 'sent_for_review' as const : t.status === 'Done' ? 'received' as const : 'outstanding' as const, source: t.url, date: t.due})));
    summary = packet.summary;
    artifacts = [packet];
  } else if (agentId === 'life.ops') {
    const checklist = arrivalChecklist(tasks, tasks.find((t) => /parent/i.test(t.title) && t.due)?.due?.slice(0, 10) ?? now.toISOString().slice(0, 10));
    summary = checklist.summary;
    artifacts = [checklist];
  }
  if (agentId !== 'open.source') await finishAgentRun(run.id, {status: 'completed', artifacts, verifier: {summary}});
  return {outcome: 'completed', result: {summary, artifacts, approvals, taskIds: tasks.map((t) => t.id)}};
}
