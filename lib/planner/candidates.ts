import {z} from 'zod';
import {supports, type Blueprint} from '../blueprint';
import {daysUntil} from '../time';
import type {BlockLabel, Task} from '../types';
import {titleMatches, type ConversationState} from './conversation-state';
import type {ContextSnapshot, PlannerFeedback} from './snapshot';

export const CandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  concreteNextAction: z.string(),
  expectedOutcome: z.string(),
  proposedBlock: z.enum(['FOCUS', 'CLOSE', 'MAINTAIN', 'EXPAND']),
  sourceIds: z.array(z.string()),
  provenance: z.enum(['explicit', 'derived', 'suggested']),
  status: z.enum(['ready', 'waiting', 'suggested', 'completed', 'excluded']),
  dueAt: z.string().nullable(),
  urgency: z.number(),
  impact: z.number(),
  goalAlignment: z.number(),
  durationMinutes: z.number(),
  energyRequired: z.enum(['Low', 'Medium', 'High']),
  readiness: z.number(),
  confidence: z.number(),
  lastVerifiedAt: z.string().nullable(),
  completionEvidence: z.string().nullable(),
  whyNow: z.string(),
  notionTaskId: z.string().nullable(),
  mergeKey: z.string(),
  assumedDuration: z.boolean(),
  source: z.string()
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const STALE_WAITING_DAYS = 7;
export const DEFAULT_DURATION: Record<BlockLabel, number> = {FOCUS: 45, CLOSE: 10, MAINTAIN: 15, EXPAND: 15};
export const TIRED_DURATION: Record<BlockLabel, number> = {FOCUS: 20, CLOSE: 2, MAINTAIN: 5, EXPAND: 5};

const MAINTAIN_PATTERN = /\b(home|health|fitness|gym|meal|cook|groceries|laundry|clean|tidy|appointment|doctor|dentist|walk|exercise|sleep|rest|family|parents|guest|apartment|errand|pack|travel|road trip|car|rental)\b/i;
const EXPAND_PATTERN = /\b(learn|create|draft|write|sketch|practice|experiment|grow|creative|art|music|side project|app|course|read|explore|try)\b/i;
const CLOSE_PATTERN = /\b(follow up|follow-up|reply|send|confirm|file|pay|book|decide|approve|submit|close|check in|nudge)\b/i;
const VERB_START =
  /^(do|write|draft|send|call|email|file|pay|book|review|fix|open|update|prepare|pack|clean|schedule|reply|submit|follow|decide|list|capture|start|check|read|plan|move|set|ask|confirm|finish|close|stretch|walk|cook|buy|sort|learn|sketch|practice|try|explore|create|nudge|spend)\b/i;

function normalizeTitle(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function mergeKey(source: string, external: string, title: string) {
  return `${source}:${external}:${normalizeTitle(title)}`;
}

export function durationFor(block: BlockLabel, tired: boolean, explicit?: number | null) {
  if (explicit && explicit > 0) return Math.min(explicit, block === 'FOCUS' ? 90 : 45);
  return tired ? TIRED_DURATION[block] : DEFAULT_DURATION[block];
}

export function decomposeNextStep(task: Pick<Task, 'title' | 'nextAction'>): string {
  const next = task.nextAction?.trim();
  if (next) return next.length > 140 ? `${next.slice(0, 137)}…` : next;
  const title = task.title.trim();
  if (VERB_START.test(title)) return title.length > 140 ? `${title.slice(0, 137)}…` : title;
  return `Do the next physical step on “${title}”`;
}

function impactOf(task: Task) {
  return {Urgent: 90, High: 70, Medium: 45, Low: 25, None: 35}[task.priority];
}

function urgencyOf(due: string | null, date: string) {
  if (!due) return 20;
  const d = daysUntil(due, date);
  if (d < 0) return 95;
  if (d === 0) return 85;
  if (d === 1) return 70;
  if (d <= 3) return 55;
  if (d <= 7) return 35;
  return 15;
}

function goalAlignment(task: {title: string; project?: string | null}, blueprint: Blueprint | null) {
  if (!blueprint) return 0;
  if (blueprint.nonNegotiables.some((line) => supports(task, line) || titleMatches(task.title, line))) return 40;
  if (blueprint.quarterlyPriorities.some((line) => supports(task, line))) return 30;
  if (blueprint.activeProjects.some((line) => supports(task, line))) return 20;
  if (blueprint.goals.some((line) => supports(task, line))) return 16;
  if (blueprint.context.some((line) => supports(task, line) || titleMatches(task.title, line))) return 22;
  return 0;
}

function completedRecently(task: Task, conversation: ConversationState, feedback: PlannerFeedback[]) {
  if (task.status === 'Done' || task.status === 'Canceled') return true;
  if (conversation.completions.some((c) => c.notionId === task.id || titleMatches(c.title, task.title))) return true;
  if (conversation.cancellations.some((c) => c.notionId === task.id || titleMatches(c.title, task.title))) return true;
  return feedback.some((f) => (f.taskId === task.id || titleMatches(f.taskId, task.title)) && (f.kind === 'done' || f.kind === 'complete'));
}

function excludedByFeedback(id: string, feedback: PlannerFeedback[]) {
  const now = Date.now();
  return feedback.some((f) => {
    if (f.taskId !== id) return false;
    const age = now - Date.parse(f.createdAt);
    if ((f.kind === 'done' || f.kind === 'complete') && age < 24 * 3600 * 1000) return true;
    if ((f.kind === 'skip' || f.kind === 'postpone' || f.kind === 'not_now' || f.kind === 'not_relevant' || f.kind === 'replace') && age < 6 * 3600 * 1000) return true;
    return false;
  });
}

function candidate(partial: Omit<Candidate, 'assumedDuration'> & {assumedDuration?: boolean}): Candidate {
  const parsed = CandidateSchema.parse({assumedDuration: false, ...partial});
  return parsed;
}

export function fromExplicitTasks(snapshot: ContextSnapshot): Candidate[] {
  const tired = snapshot.capacityMode === 'tired';
  return snapshot.tasks
    .filter((t) => (t.status === 'Ready' || t.status === 'In Progress') && !t.blocker && !completedRecently(t, snapshot.conversation, snapshot.feedback))
    .filter((t) => !(snapshot.capacityMode === 'tired' && t.energy === 'High'))
    .filter((t) => !/\b(verify|confirm|check)\b.*\b(deadline|due|date)\b/i.test(`${t.title} ${t.nextAction ?? ''}`))
    .filter((t) => !excludedByFeedback(t.id, snapshot.feedback))
    .filter((t) => !t.blockedBy.length || t.blockedBy.every((id) => snapshot.tasks.find((x) => x.id === id)?.status === 'Done' || snapshot.tasks.find((x) => x.id === id)?.status === 'Canceled'))
    .map((t) => {
      const maintain = t.context === 'Home' || MAINTAIN_PATTERN.test(t.title) || MAINTAIN_PATTERN.test(t.nextAction ?? '');
      const expand = EXPAND_PATTERN.test(t.title) && !maintain;
      const close = (t.duration !== null && t.duration <= 15) || CLOSE_PATTERN.test(t.title) || CLOSE_PATTERN.test(t.nextAction ?? '');
      const block: BlockLabel = maintain ? 'MAINTAIN' : close && !expand ? 'CLOSE' : expand ? 'EXPAND' : 'FOCUS';
      const next = decomposeNextStep(t);
      return candidate({
        id: `task:${t.id}`,
        title: t.title,
        concreteNextAction: next,
        expectedOutcome: `“${t.title}” is one concrete step further.`,
        proposedBlock: block,
        sourceIds: [`notion:${t.id}`],
        provenance: 'explicit',
        status: 'ready',
        dueAt: t.due,
        urgency: urgencyOf(t.due, snapshot.date),
        impact: impactOf(t),
        goalAlignment: goalAlignment(t, snapshot.blueprint),
        durationMinutes: durationFor(block, tired, t.duration),
        energyRequired: tired && t.energy === 'High' ? 'Medium' : t.energy,
        readiness: t.status === 'In Progress' ? 90 : 80,
        confidence: 0.9,
        lastVerifiedAt: t.lastEditedAt,
        completionEvidence: null,
        whyNow: t.due ? `Due ${t.due} and already ${t.status.toLowerCase()} in Notion.` : `Ready in Notion and needs a next physical step.`,
        notionTaskId: t.id,
        mergeKey: mergeKey('notion', t.externalKey || t.id, t.title),
        assumedDuration: t.duration === null,
        source: 'explicit_tasks'
      });
    });
}

export function fromWaitingFollowups(snapshot: ContextSnapshot): Candidate[] {
  const today = snapshot.date;
  return snapshot.tasks
    .filter((t) => t.status === 'Waiting' || t.status === 'Waiting for User')
    .filter((t) => !completedRecently(t, snapshot.conversation, snapshot.feedback))
    .flatMap((t) => {
      const idle = t.lastEditedAt ? Math.floor((Date.parse(`${today}T12:00:00.000Z`) - Date.parse(t.lastEditedAt)) / 86400000) : 0;
      if (idle < STALE_WAITING_DAYS) return [];
      return [
        candidate({
          id: `followup:${t.id}`,
          title: `Follow up on “${t.title}”`,
          concreteNextAction: `Send a short follow-up on “${t.title}”.`,
          expectedOutcome: `You know whether “${t.title}” is still waiting.`,
          proposedBlock: 'CLOSE',
          sourceIds: [`notion:${t.id}`],
          provenance: 'derived',
          status: 'waiting',
          dueAt: t.due,
          urgency: Math.min(90, 40 + idle),
          impact: 40,
          goalAlignment: goalAlignment(t, snapshot.blueprint),
          durationMinutes: durationFor('CLOSE', snapshot.capacityMode === 'tired'),
          energyRequired: 'Low',
          readiness: 70,
          confidence: 0.7,
          lastVerifiedAt: t.lastEditedAt,
          completionEvidence: null,
          whyNow: `Waiting with no Notion update for ${idle} days.`,
          notionTaskId: null,
          mergeKey: mergeKey('followup', t.id, t.title),
          source: 'explicit_tasks'
        })
      ];
    });
}

export function fromProjectNextSteps(snapshot: ContextSnapshot): Candidate[] {
  const projects = snapshot.blueprint?.activeProjects ?? [];
  const ready = snapshot.tasks.filter((t) => t.status === 'Ready' || t.status === 'In Progress');
  return projects
    .filter((project) => !ready.some((t) => supports(t, project) || titleMatches(t.project ?? '', project)))
    .slice(0, 3)
    .map((project, i) =>
      candidate({
        id: `project:${i}`,
        title: `Next step for ${project}`,
        concreteNextAction: `Write the next physical step for “${project}”.`,
        expectedOutcome: `“${project}” has a concrete next action.`,
        proposedBlock: 'FOCUS',
        sourceIds: [`blueprint:project:${i}`],
        provenance: 'derived',
        status: 'ready',
        dueAt: null,
        urgency: 25,
        impact: 55,
        goalAlignment: 20,
        durationMinutes: durationFor('FOCUS', snapshot.capacityMode === 'tired'),
        energyRequired: snapshot.capacityMode === 'tired' ? 'Low' : 'Medium',
        readiness: 60,
        confidence: 0.55,
        lastVerifiedAt: null,
        completionEvidence: null,
        whyNow: `Active project “${project}” has no ready next step in Notion.`,
        notionTaskId: null,
        mergeKey: mergeKey('project', String(i), project),
        assumedDuration: true,
        source: 'project_next_steps'
      })
    );
}

export function fromConversationCommitments(snapshot: ContextSnapshot): Candidate[] {
  return snapshot.conversation.commitments
    .filter((c) => c.confirmed)
    .filter((c) => !snapshot.conversation.completions.some((x) => titleMatches(x.title, c.title)))
    .filter((c) => !snapshot.tasks.some((t) => (c.notionId && t.id === c.notionId) || titleMatches(t.title, c.title)))
    .map((c, i) =>
      candidate({
        id: `commit:${i}:${normalizeTitle(c.title).replace(/\s+/g, '-')}`,
        title: c.title,
        concreteNextAction: decomposeNextStep({title: c.title, nextAction: null}),
        expectedOutcome: `The commitment “${c.title}” moves forward.`,
        proposedBlock: MAINTAIN_PATTERN.test(c.title) ? 'MAINTAIN' : CLOSE_PATTERN.test(c.title) ? 'CLOSE' : 'FOCUS',
        sourceIds: [`intake:${c.sourceKey}`],
        provenance: c.notionId ? 'explicit' : 'derived',
        status: 'ready',
        dueAt: c.due,
        urgency: urgencyOf(c.due, snapshot.date),
        impact: 50,
        goalAlignment: goalAlignment({title: c.title}, snapshot.blueprint),
        durationMinutes: durationFor(MAINTAIN_PATTERN.test(c.title) ? 'MAINTAIN' : 'CLOSE', snapshot.capacityMode === 'tired'),
        energyRequired: 'Low',
        readiness: 65,
        confidence: 0.6,
        lastVerifiedAt: null,
        completionEvidence: null,
        whyNow: 'Confirmed in chat and not yet on the Notion board.',
        notionTaskId: c.notionId,
        mergeKey: mergeKey('conversation', c.sourceKey, c.title),
        assumedDuration: true,
        source: 'conversation_commitments'
      })
    );
}

export function fromCalendar(snapshot: ContextSnapshot): Candidate[] {
  if (snapshot.calendar.state !== 'connected') return [];
  return snapshot.events
    .filter((e) => e.title.trim() && !e.allDay)
    .slice(0, 6)
    .map((e, i) =>
      candidate({
        id: `cal:${e.id || i}`,
        title: `Prep for “${e.title}”`,
        concreteNextAction: `Write 3 bullets to walk into “${e.title}”.`,
        expectedOutcome: `You arrive at “${e.title}” with a short plan.`,
        proposedBlock: 'CLOSE',
        sourceIds: [`calendar:${e.id}`],
        provenance: 'derived',
        status: 'ready',
        dueAt: e.start,
        urgency: 50,
        impact: 40,
        goalAlignment: 0,
        durationMinutes: durationFor('CLOSE', snapshot.capacityMode === 'tired', 10),
        energyRequired: 'Low',
        readiness: 75,
        confidence: 0.65,
        lastVerifiedAt: snapshot.calendar.lastSyncedAt,
        completionEvidence: null,
        whyNow: `Named calendar event already exists; this is prep, not a new meeting.`,
        notionTaskId: null,
        mergeKey: mergeKey('calendar', e.id, e.title),
        source: 'calendar_derived'
      })
    );
}

export function fromInboxFollowups(snapshot: ContextSnapshot): Candidate[] {
  return (snapshot.digest?.actions ?? [])
    .filter((action) => !snapshot.conversation.completions.some((c) => titleMatches(c.title, action.title)))
    .filter((action) => !snapshot.tasks.some((t) => (t.status === 'Done' || t.status === 'Canceled') && titleMatches(t.title, action.title)))
    .slice(0, 8)
    .map((action, i) =>
    candidate({
      id: `mail:${i}:${normalizeTitle(action.title).replace(/\s+/g, '-').slice(0, 32)}`,
      title: action.title,
      concreteNextAction: decomposeNextStep({title: action.title, nextAction: null}),
      expectedOutcome: `The follow-up “${action.title}” is handled or parked.`,
      proposedBlock: 'CLOSE',
      sourceIds: [`digest:${i}`],
      provenance: 'derived',
      status: 'ready',
      dueAt: action.due,
      urgency: urgencyOf(action.due, snapshot.date),
      impact: action.bucket === 'deadline' || action.bucket === 'needs_response' ? 60 : 40,
      goalAlignment: 0,
      durationMinutes: durationFor('CLOSE', snapshot.capacityMode === 'tired'),
      energyRequired: 'Low',
      readiness: 70,
      confidence: 0.6,
      lastVerifiedAt: snapshot.digest?.generatedAt ?? null,
      completionEvidence: null,
      whyNow: 'Already extracted onto today’s Gmail digest.',
      notionTaskId: null,
      mergeKey: mergeKey('digest', action.permalink || String(i), action.title),
      assumedDuration: true,
      source: 'inbox_followups'
    })
  );
}

export function fromRoutines(snapshot: ContextSnapshot): Candidate[] {
  const lines = [...(snapshot.blueprint?.routines ?? []), ...(snapshot.blueprint?.recurringCommitments ?? [])];
  return lines.slice(0, 6).map((line, i) =>
    candidate({
      id: `routine:${i}`,
      title: line,
      concreteNextAction: VERB_START.test(line) ? line : `Do today’s “${line}”.`,
      expectedOutcome: `Today’s “${line}” is done.`,
      proposedBlock: 'MAINTAIN',
      sourceIds: [`blueprint:routine:${i}`],
      provenance: 'derived',
      status: 'ready',
      dueAt: snapshot.date,
      urgency: 30,
      impact: 45,
      goalAlignment: 12,
      durationMinutes: durationFor('MAINTAIN', snapshot.capacityMode === 'tired'),
      energyRequired: 'Low',
      readiness: 80,
      confidence: 0.7,
      lastVerifiedAt: null,
      completionEvidence: null,
      whyNow: snapshot.hasPrivateMaintainSignal ? 'Confirmed routine; private notes stay out of this plan.' : 'Confirmed Blueprint routine for today.',
      notionTaskId: null,
      mergeKey: mergeKey('routine', String(i), line),
      assumedDuration: true,
      source: 'recurring_routines'
    })
  );
}

export function fromApprovals(snapshot: ContextSnapshot): Candidate[] {
  return snapshot.approvals
    .filter((a) => a.status === 'pending')
    .slice(0, 4)
    .map((a) =>
      candidate({
        id: `approval:${a.id}`,
        title: `Decide: ${a.action}`,
        concreteNextAction: `Review the pending ${a.action} approval.`,
        expectedOutcome: `The ${a.action} request is approved or rejected.`,
        proposedBlock: 'CLOSE',
        sourceIds: [`approval:${a.id}`],
        provenance: 'explicit',
        status: 'ready',
        dueAt: null,
        urgency: a.risk === 'high' ? 80 : 50,
        impact: 55,
        goalAlignment: 0,
        durationMinutes: durationFor('CLOSE', snapshot.capacityMode === 'tired', 5),
        energyRequired: 'Low',
        readiness: 85,
        confidence: 0.85,
        lastVerifiedAt: null,
        completionEvidence: null,
        whyNow: `Pending approval (${a.risk} risk) is blocking an agent action.`,
        notionTaskId: null,
        mergeKey: mergeKey('approval', a.id, a.action),
        source: 'agent_approvals'
      })
    );
}

export function fromGoals(snapshot: ContextSnapshot): Candidate[] {
  const goal = snapshot.blueprint?.goals[0] || snapshot.blueprint?.experiments[0];
  if (!goal) return [];
  return [
    candidate({
      id: `goal:0`,
      title: goal,
      concreteNextAction: `Spend ${durationFor('EXPAND', snapshot.capacityMode === 'tired')} minutes on “${goal}”.`,
      expectedOutcome: `One small growth step on “${goal}” exists.`,
      proposedBlock: 'EXPAND',
      sourceIds: ['blueprint:goal:0'],
      provenance: 'suggested',
      status: 'suggested',
      dueAt: null,
      urgency: 10,
      impact: 40,
      goalAlignment: 24,
      durationMinutes: durationFor('EXPAND', snapshot.capacityMode === 'tired'),
      energyRequired: snapshot.capacityMode === 'tired' ? 'Low' : 'Medium',
      readiness: 50,
      confidence: 0.4,
      lastVerifiedAt: null,
      completionEvidence: null,
      whyNow: 'Suggested from a confirmed Blueprint goal; not a commitment.',
      notionTaskId: null,
      mergeKey: mergeKey('goal', '0', goal),
      assumedDuration: true,
      source: 'goal_expansion'
    })
  ];
}

export function generateCandidates(snapshot: ContextSnapshot): Candidate[] {
  const raw = [
    ...fromExplicitTasks(snapshot),
    ...fromWaitingFollowups(snapshot),
    ...fromProjectNextSteps(snapshot),
    ...fromConversationCommitments(snapshot),
    ...fromCalendar(snapshot),
    ...fromInboxFollowups(snapshot),
    ...fromRoutines(snapshot),
    ...fromApprovals(snapshot),
    ...fromGoals(snapshot)
  ];
  const byKey = new Map<string, Candidate>();
  for (const c of raw) {
    const prev = byKey.get(c.mergeKey);
    if (!prev || c.confidence > prev.confidence || (c.provenance === 'explicit' && prev.provenance !== 'explicit')) byKey.set(c.mergeKey, c);
  }
  return [...byKey.values()].filter((c) => c.status !== 'completed' && c.status !== 'excluded');
}

export function countsBySource(candidates: Candidate[]) {
  const out: Record<string, number> = {};
  for (const c of candidates) out[c.source] = (out[c.source] ?? 0) + 1;
  return out;
}
