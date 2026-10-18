import {defaultIntakeDeps, type IntakeDeps} from './intake';
import {addFeedback} from './intake-store';
import type {FeedbackKind} from './next-action';
import {NotionWriteError} from './notion-write';
import {audit, getBriefing} from './store';
import {localDate} from './time';
import {BRIEFING_VERSION, type BlockLabel, type BriefingSnapshot} from './types';

export type FeedbackOutcome = {
  recorded: true;
  notion: 'marked_done' | 'already_done' | 'failed' | 'not_applicable';
  message: string;
  briefing: string | null;
  explain?: {whyNow: string | null; sourceIds: string[]; provenance: string | null};
};

const DONE_KINDS = new Set<FeedbackKind>(['done', 'complete']);

/**
 * Stores feedback on a recommendation. "Done" is the user's own statement; it always writes to Notion
 * (independent of chat task-update permission) and is only reported as marked after Notion shows the new status.
 */
export async function recordFeedback(
  userId: string,
  input: {
    taskId: string;
    kind: FeedbackKind;
    minutes: number | null;
    energy: string | null;
    context: string | null;
    block?: BlockLabel | null;
    candidateId?: string | null;
  },
  deps: Pick<IntakeDeps, 'target' | 'retrieve' | 'update' | 'refresh' | 'now'> = defaultIntakeDeps
): Promise<FeedbackOutcome> {
  await addFeedback({userId, taskId: input.taskId, kind: input.kind, minutes: input.minutes, energy: input.energy, context: input.context});
  await audit(userId, 'next_action.feedback', 'ok', {kind: input.kind, block: input.block ?? null});

  if (input.kind === 'explain') {
    const row = await getBriefing(userId, localDate(deps.now()), BRIEFING_VERSION);
    const snapshot = row?.snapshot as BriefingSnapshot | undefined;
    const block = snapshot?.blocks.find((b) => b.candidateId === input.candidateId || b.candidateId === input.taskId || b.label === input.block || b.task?.id === input.taskId);
    return {
      recorded: true,
      notion: 'not_applicable',
      message: block?.whyNow || block?.reason || 'No stored reason for that block.',
      briefing: null,
      explain: {whyNow: block?.whyNow ?? null, sourceIds: block?.candidateId ? [block.candidateId] : [], provenance: block?.provenance ?? null}
    };
  }

  if (input.kind === 'replace' || input.kind === 'shrink') {
    const briefing = await deps.refresh(userId, [], [], `feedback:${userId}:${input.kind}:${input.taskId}:${Date.now()}`, deps.now()).catch(() => 'failed');
    return {
      recorded: true,
      notion: 'not_applicable',
      message: input.kind === 'shrink' ? 'Using a smaller version of that block.' : 'Replaced that block from remaining candidates.',
      briefing: briefing === 'failed' || briefing === 'skipped' ? briefing : 'refreshed'
    };
  }

  if (input.kind === 'skip' || input.kind === 'postpone') {
    return {recorded: true, notion: 'not_applicable', message: 'Got it. Deevaa will not suggest it again for a few hours.', briefing: null};
  }
  if (input.kind === 'not_relevant') {
    return {recorded: true, notion: 'not_applicable', message: 'Thanks. Deevaa will rank it lower for two weeks.', briefing: null};
  }

  if (!DONE_KINDS.has(input.kind)) {
    const message = {
      not_now: 'Got it. Deevaa will not suggest it again for a few hours.',
      not_possible_here: 'Got it. Deevaa will not suggest it in this place for a week.',
      wrong: 'Thanks. Deevaa will rank it lower for two weeks.'
    }[input.kind as 'not_now' | 'not_possible_here' | 'wrong'];
    return {recorded: true, notion: 'not_applicable', message, briefing: null};
  }

  try {
    const target = await deps.target();
    const {task} = await deps.retrieve(target, input.taskId);
    if (!task) return {recorded: true, notion: 'failed', message: 'That task is no longer in Notion.', briefing: null};
    if (task.status === 'Done') return {recorded: true, notion: 'already_done', message: 'Notion already shows it as Done.', briefing: null};
    const {task: updated} = await deps.update(target, input.taskId, {status: 'Done', nextAction: 'You marked this done in Deevaa'});
    await audit(userId, 'notion.task.done', 'ok', {source: 'next_action'});
    const briefing = await deps.refresh(userId, [updated], [], `feedback:${userId}:${input.taskId}:${Date.now()}`, deps.now()).catch(() => 'failed');
    return {recorded: true, notion: 'marked_done', message: `Marked “${updated.title}” Done in Notion and verified it.`, briefing};
  } catch (e) {
    await audit(userId, 'notion.task.done', 'error', {code: e instanceof NotionWriteError ? e.code : 'internal'});
    return {recorded: true, notion: 'failed', message: e instanceof NotionWriteError ? e.message : 'Notion could not be updated.', briefing: null};
  }
}
