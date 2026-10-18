import type {BlockLabel} from '../types';
import type {Candidate} from './candidates';

const VERB =
  /^(do|write|draft|send|call|email|file|pay|book|review|fix|open|update|prepare|pack|clean|schedule|reply|submit|follow|decide|list|capture|start|check|read|plan|move|set|ask|confirm|finish|close|stretch|walk|cook|buy|sort|learn|sketch|practice|try|explore|create|nudge|spend|review)\b/i;

export type ValidationResult = {ok: true} | {ok: false; reason: string};

export function validateCandidate(
  candidate: Candidate,
  label: BlockLabel,
  used: Set<string>,
  remainingMinutes: number | null
): ValidationResult {
  if (!candidate.concreteNextAction.trim() || !VERB.test(candidate.concreteNextAction.trim())) return {ok: false, reason: 'not_concrete'};
  if (!candidate.expectedOutcome.trim()) return {ok: false, reason: 'no_outcome'};
  if (!candidate.provenance) return {ok: false, reason: 'no_provenance'};
  if (candidate.status === 'completed' || candidate.status === 'excluded') return {ok: false, reason: 'invalid_lifecycle'};
  if (candidate.status === 'waiting' && label !== 'CLOSE') return {ok: false, reason: 'waiting_not_close'};
  if (candidate.durationMinutes <= 0) return {ok: false, reason: 'bad_duration'};
  if (remainingMinutes !== null && remainingMinutes > 0 && candidate.durationMinutes > remainingMinutes + 30) return {ok: false, reason: 'duration_exceeds_free'};
  if (used.has(candidate.id) || (candidate.notionTaskId && used.has(candidate.notionTaskId)) || used.has(candidate.mergeKey)) return {ok: false, reason: 'duplicate'};
  if (!candidate.whyNow.trim()) return {ok: false, reason: 'no_why'};
  return {ok: true};
}
