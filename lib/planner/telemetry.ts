import {logEvent} from '../log';
import type {BlockLabel, PlanTrace} from '../types';

export function emptyTrace(): PlanTrace {
  return {
    plannerVersion: 2,
    readyCount: 0,
    candidateCountBySource: {},
    candidateCountByBlock: {},
    rejections: {},
    selected: [],
    validationPasses: 0,
    generationPasses: 1,
    sourceFreshness: {}
  };
}

export function bump(rejections: Record<string, number>, reason: string) {
  rejections[reason] = (rejections[reason] ?? 0) + 1;
}

export function logPlannerV2(trace: PlanTrace) {
  logEvent('info', 'planner.v2', {
    plannerVersion: trace.plannerVersion,
    readyCount: trace.readyCount,
    candidateCount: Object.values(trace.candidateCountBySource).reduce((s, n) => s + n, 0),
    focusCandidates: trace.candidateCountByBlock.FOCUS ?? 0,
    closeCandidates: trace.candidateCountByBlock.CLOSE ?? 0,
    maintainCandidates: trace.candidateCountByBlock.MAINTAIN ?? 0,
    expandCandidates: trace.candidateCountByBlock.EXPAND ?? 0,
    selectedCount: trace.selected.filter((s) => s.candidateId).length,
    validationPasses: trace.validationPasses,
    generationPasses: trace.generationPasses,
    rejectionCount: Object.values(trace.rejections).reduce((s, n) => s + n, 0)
  });
}

export function selectedIds(selected: {label: BlockLabel; candidateId: string | null}[]) {
  return selected.map((s) => s.candidateId).filter(Boolean);
}
