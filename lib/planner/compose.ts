import {formatLocalTime} from '../time';
import {BLOCK_ROLE, type Block, type BlockLabel, type Interval, type Task, type TaskRef} from '../types';
import {countsBySource, generateCandidates, type Candidate} from './candidates';
import {rankForBlock} from './score';
import {sourceFreshness, type ContextSnapshot} from './snapshot';
import {bump, emptyTrace, logPlannerV2} from './telemetry';
import {validateCandidate} from './validate';
import {Allocator, MAX_PLANNED_SHARE, UNKNOWN_FOCUS_MINUTES} from './v1';
import {gapMinutes, type Gap} from './windows';

const LABELS: BlockLabel[] = ['FOCUS', 'CLOSE', 'MAINTAIN', 'EXPAND'];
const EMPTY = 'No grounded action found';
const NO_CALENDAR = 'Calendar not connected, so no time window is claimed.';

function toRef(task: Task): TaskRef {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due: task.due,
    duration: task.duration,
    url: task.url,
    sourceLink: task.sourceLink,
    source: task.source,
    project: task.project ?? null
  };
}

function windowLabel(slot: Interval) {
  return `${formatLocalTime(slot.start)}–${formatLocalTime(slot.end)}`;
}

function taskFor(candidate: Candidate, snapshot: ContextSnapshot): TaskRef | null {
  if (!candidate.notionTaskId) return null;
  const task = snapshot.tasks.find((t) => t.id === candidate.notionTaskId);
  return task ? toRef(task) : null;
}

function emptyBlock(label: BlockLabel, reason: string, emptyDetail?: string | null): Block {
  return {
    label,
    role: BLOCK_ROLE[label],
    state: 'omitted',
    task: null,
    start: null,
    end: null,
    reason,
    nextAction: null,
    expectedOutcome: null,
    provenance: null,
    whyNow: null,
    emptyDetail: emptyDetail ?? reason,
    candidateId: null
  };
}

function enrich(block: Block, candidate: Candidate, snapshot: ContextSnapshot): Block {
  return {
    ...block,
    role: BLOCK_ROLE[block.label],
    nextAction: candidate.concreteNextAction,
    expectedOutcome: candidate.expectedOutcome,
    provenance: candidate.provenance,
    whyNow: candidate.whyNow,
    emptyDetail: null,
    candidateId: candidate.id,
    task: taskFor(candidate, snapshot)
  };
}

function placeReason(candidate: Candidate, why: string, slot: Interval | null, calendarOk: boolean) {
  const assumed =
    candidate.assumedDuration && candidate.proposedBlock === 'FOCUS' && candidate.durationMinutes === UNKNOWN_FOCUS_MINUTES
      ? ' Duration is not set in Notion, so a 45-minute block is assumed.'
      : candidate.assumedDuration && candidate.notionTaskId
        ? ` Duration is not set in Notion, so a ${candidate.durationMinutes}-minute block is assumed.`
        : '';
  if (!calendarOk) return `${why} ${NO_CALENDAR}${assumed}`;
  if (!slot) return why;
  return `${why} Open ${windowLabel(slot)}.${assumed}`;
}

function noWindowReason(minutes: number) {
  return `No open ${minutes}-minute window remains after meetings, preparation, transitions and protected sleep (10:30 PM–7:00 AM).`;
}

export function composeBlocks(snapshot: ContextSnapshot, gaps: Gap[] | null): {blocks: Block[]; candidates: Candidate[]; trace: ReturnType<typeof emptyTrace>} {
  const candidates = generateCandidates(snapshot);
  const trace = emptyTrace();
  trace.readyCount = snapshot.tasks.filter((t) => t.status === 'Ready' || t.status === 'In Progress').length;
  trace.candidateCountBySource = countsBySource(candidates);
  trace.sourceFreshness = sourceFreshness(snapshot);
  trace.generationPasses = 1;

  const freeTotal = gaps ? gaps.reduce((s, g) => s + gapMinutes(g), 0) : null;
  const maxShare = snapshot.capacityMode === 'tired' ? 0.45 : MAX_PLANNED_SHARE;
  const alloc = gaps ? new Allocator(gaps.map((g) => ({...g})), Math.floor((freeTotal ?? 0) * maxShare)) : null;
  const used = new Set<string>();
  const usedSources = new Set<string>();
  const blocks: Block[] = [];
  let remaining = freeTotal;

  for (const label of LABELS) {
    const ranked = rankForBlock(candidates, label, snapshot, remaining);
    trace.candidateCountByBlock[label] = ranked.length;
    const tryPick = (pool: typeof ranked): Candidate | null => {
      for (const row of pool) {
        const check = validateCandidate(row.candidate, label, used, remaining);
        if (!check.ok) {
          bump(trace.rejections, check.reason);
          continue;
        }
        if (row.candidate.provenance === 'suggested' && label !== 'EXPAND') {
          bump(trace.rejections, 'suggested_not_commitment');
          continue;
        }
        trace.validationPasses++;
        return row.candidate;
      }
      return null;
    };

    let picked = tryPick(ranked);
    if (!picked) {
      trace.generationPasses = Math.max(trace.generationPasses, 2);
      const unused = rankForBlock(
        candidates.filter((c) => !used.has(c.id) && (c.proposedBlock === label || !usedSources.has(c.source))),
        label,
        snapshot,
        remaining
      );
      picked = tryPick(unused);
    }

    if (!picked) {
      const suggested = candidates.find((c) => c.proposedBlock === label && c.provenance === 'suggested' && !used.has(c.id));
      blocks.push(emptyBlock(label, EMPTY, suggested ? `Optional: ${suggested.concreteNextAction} (suggested, not a commitment).` : EMPTY));
      bump(trace.rejections, 'no_grounded_action');
      trace.selected.push({label, candidateId: null});
      continue;
    }

    const length = picked.durationMinutes;
    const why =
      label === 'FOCUS'
        ? 'Highest-ranked task that needs sustained attention.'
        : label === 'CLOSE'
          ? 'One small open loop; do not stack more.'
          : label === 'MAINTAIN'
            ? 'Supports health or home.'
            : 'Time for people, learning, connection or creativity.';

    if (!alloc) {
      used.add(picked.id);
      if (picked.notionTaskId) used.add(picked.notionTaskId);
      used.add(picked.mergeKey);
      usedSources.add(picked.source);
      blocks.push(
        enrich(
          {
            label,
            state: 'unscheduled',
            task: null,
            start: null,
            end: null,
            reason: placeReason(picked, why, null, false)
          },
          picked,
          snapshot
        )
      );
      trace.selected.push({label, candidateId: picked.id});
      continue;
    }

    const slot = alloc.place(length);
    if (slot) {
      used.add(picked.id);
      if (picked.notionTaskId) used.add(picked.notionTaskId);
      used.add(picked.mergeKey);
      usedSources.add(picked.source);
      remaining = remaining === null ? null : Math.max(0, remaining - length);
      blocks.push(
        enrich(
          {
            label,
            state: 'scheduled',
            task: null,
            start: slot.start,
            end: slot.end,
            reason: placeReason(picked, why, slot, true)
          },
          picked,
          snapshot
        )
      );
      trace.selected.push({label, candidateId: picked.id});
      continue;
    }

    const omitReason = alloc.hasSpace(length) ? 'Skipped to keep slack in an already full day.' : noWindowReason(length);
    bump(trace.rejections, alloc.hasSpace(length) ? 'slack_budget' : 'no_window');
    blocks.push(emptyBlock(label, omitReason));
    trace.selected.push({label, candidateId: null});
  }

  logPlannerV2(trace);
  return {blocks, candidates, trace};
}

/** Re-pick one block from remaining candidates after feedback. */
export function replaceBlock(
  snapshot: ContextSnapshot,
  gaps: Gap[] | null,
  current: Block[],
  label: BlockLabel,
  excludeId: string | null
): Block[] {
  const nextSnap = {
    ...snapshot,
    feedback: [...snapshot.feedback, ...(excludeId ? [{taskId: excludeId, kind: 'replace', createdAt: snapshot.now.toISOString()}] : [])]
  };
  const {blocks} = composeBlocks(nextSnap, gaps);
  return current.map((block) => (block.label === label ? blocks.find((b) => b.label === label) ?? block : block));
}

export function shrinkBlock(snapshot: ContextSnapshot, gaps: Gap[] | null): Block[] {
  return composeBlocks({...snapshot, capacityMode: 'tired'}, gaps).blocks;
}
