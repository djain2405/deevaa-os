import type {BlockLabel} from '../types';
import type {Candidate} from './candidates';
import type {ContextSnapshot} from './snapshot';

const MAINTAIN = /\b(home|health|fitness|gym|meal|cook|groceries|laundry|clean|tidy|appointment|doctor|dentist|walk|exercise|sleep|rest|family|parents|guest|apartment|errand|pack|travel|road trip|car|rental|relationship)\b/i;
const EXPAND = /\b(learn|create|draft|write|sketch|practice|experiment|grow|creative|art|music|side project|app|course|read|explore|try|play)\b/i;
const CLOSE = /\b(follow up|follow-up|reply|send|confirm|file|pay|book|decide|approve|submit|close|check in|nudge|waiting)\b/i;
const FOCUS = /\b(write|draft|design|build|plan|research|prepare|study|deep|keynote|essay|packet|slides)\b/i;

export type ScoreBreakdown = {
  deadline: number;
  impact: number;
  preference: number;
  energy: number;
  fit: number;
  deferral: number;
  progress: number;
  alignment: number;
  total: number;
};

export function lensAffinity(candidate: Candidate, label: BlockLabel): number {
  const text = `${candidate.title} ${candidate.concreteNextAction}`;
  if (label === 'FOCUS') {
    if (candidate.status === 'waiting') return 0;
    if (candidate.proposedBlock === 'FOCUS') return 80;
    if (FOCUS.test(text) && candidate.durationMinutes >= 20) return 70;
    if (candidate.impact >= 70 && candidate.durationMinutes >= 20) return 60;
    return candidate.durationMinutes >= 25 ? 30 : 0;
  }
  if (label === 'CLOSE') {
    if (candidate.proposedBlock === 'CLOSE' || candidate.status === 'waiting' || candidate.source === 'agent_approvals') return 90;
    if (CLOSE.test(text) || candidate.durationMinutes <= 15) return 70;
    return 10;
  }
  if (label === 'MAINTAIN') {
    if (candidate.proposedBlock === 'MAINTAIN' || MAINTAIN.test(text)) return 90;
    return 5;
  }
  if (candidate.proposedBlock === 'EXPAND' || EXPAND.test(text)) return 80;
  return candidate.provenance === 'suggested' ? 40 : 8;
}

function feedbackPenalty(candidate: Candidate, snapshot: ContextSnapshot) {
  let penalty = 0;
  for (const f of snapshot.feedback) {
    if (f.taskId !== candidate.id && f.taskId !== candidate.notionTaskId) continue;
    if (f.kind === 'wrong' || f.kind === 'not_relevant') penalty += 30;
    if (f.kind === 'not_now' || f.kind === 'skip' || f.kind === 'postpone') penalty += 20;
    if (f.kind === 'shrink') penalty += 5;
  }
  return penalty;
}

function preferenceBoost(candidate: Candidate, snapshot: ContextSnapshot) {
  const prefs = [...(snapshot.blueprint?.preferences ?? []), ...snapshot.conversation.preferences];
  if (!prefs.length) return 0;
  const text = `${candidate.title} ${candidate.concreteNextAction}`.toLowerCase();
  return prefs.some((p) => text.includes(p.toLowerCase().slice(0, 24))) ? 12 : 0;
}

export function scoreCandidate(candidate: Candidate, label: BlockLabel, snapshot: ContextSnapshot, remainingMinutes: number | null): ScoreBreakdown {
  const affinity = lensAffinity(candidate, label);
  const deadline = candidate.urgency * 0.35;
  const impact = candidate.impact * 0.25;
  const alignment = candidate.goalAlignment * 0.4;
  const preference = preferenceBoost(candidate, snapshot);
  const energy =
    snapshot.capacityMode === 'tired' && candidate.energyRequired === 'High' ? -40 : snapshot.capacityMode === 'tired' && candidate.energyRequired === 'Low' ? 10 : 0;
  const fit = remainingMinutes === null ? 5 : candidate.durationMinutes <= remainingMinutes ? 10 : -25;
  const deferral = -feedbackPenalty(candidate, snapshot);
  const progress = candidate.readiness >= 85 ? 8 : 0;
  const total = affinity + deadline + impact + alignment + preference + energy + fit + deferral + progress;
  return {deadline, impact, preference, energy, fit, deferral, progress, alignment, total};
}

export function rankForBlock(candidates: Candidate[], label: BlockLabel, snapshot: ContextSnapshot, remainingMinutes: number | null) {
  return candidates
    .map((candidate) => ({candidate, score: scoreCandidate(candidate, label, snapshot, remainingMinutes)}))
    .filter((row) => row.score.total > 20 && lensAffinity(row.candidate, label) > 0)
    .sort((a, b) => b.score.total - a.score.total || b.candidate.confidence - a.candidate.confidence);
}
