import {defaultIntakeDeps, type IntakeDeps} from './intake';
import {addFeedback, hasPermission, NOTION_WRITE} from './intake-store';
import type {FeedbackKind} from './next-action';
import {NotionWriteError} from './notion-write';
import {audit} from './store';

export type FeedbackOutcome = {
  recorded: true;
  notion: 'marked_done' | 'already_done' | 'writes_off' | 'failed' | 'not_applicable';
  message: string;
  briefing: string | null;
};

/**
 * Stores feedback on a recommendation. "Done" is the user's own statement; it is written to Notion only when
 * task updates are on, and only reported as marked after Notion shows the new status.
 */
export async function recordFeedback(
  userId: string,
  input: {taskId: string; kind: FeedbackKind; minutes: number | null; energy: string | null; context: string | null},
  deps: Pick<IntakeDeps, 'target' | 'retrieve' | 'update' | 'refresh' | 'now'> = defaultIntakeDeps
): Promise<FeedbackOutcome> {
  await addFeedback({userId, ...input});
  await audit(userId, 'next_action.feedback', 'ok', {kind: input.kind});
  if (input.kind !== 'done') {
    const message = {
      not_now: 'Got it. Deevaa will not suggest it again for a few hours.',
      not_possible_here: 'Got it. Deevaa will not suggest it in this place for a week.',
      wrong: 'Thanks. Deevaa will rank it lower for two weeks.'
    }[input.kind];
    return {recorded: true, notion: 'not_applicable', message, briefing: null};
  }
  if (!(await hasPermission(userId, NOTION_WRITE))) {
    return {recorded: true, notion: 'writes_off', message: 'Recorded. Notion updates are off, so mark it Done in Notion yourself.', briefing: null};
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
