import {describe, expect, it} from 'vitest';
import {emptyBlueprint} from '@/lib/blueprint';
import {FEEDBACK_KINDS} from '@/lib/next-action';
import {buildBriefing, planBlocks, rankTasks} from '@/lib/planner';
import {generateCandidates} from '@/lib/planner/candidates';
import {projectConversation} from '@/lib/planner/conversation-state';
import {snapshotFromPlanInput} from '@/lib/planner/snapshot';
import {connected, notConnected, task} from './helpers';
import {
  DATE,
  NIGHT_BEFORE,
  creativeBlueprint,
  deadlineClash,
  emptyConversation,
  exhaustedTasks,
  mattLetter,
  parentsArrivalBlueprint,
  parentsArrivalTasks,
  planInput,
  tdliSubmitted
} from './fixtures/planner-v2';

function v1Blocks(input: ReturnType<typeof planInput>) {
  const ranked = rankTasks(input.tasks, input.date, input.blueprint ?? null);
  return planBlocks(ranked, null);
}

describe('planner V2 vs V1', () => {
  it('parents arrival and road trip fill Maintain/Close instead of leaving them empty', () => {
    const input = planInput({
      tasks: parentsArrivalTasks(),
      blueprint: parentsArrivalBlueprint(),
      calendar: notConnected()
    });
    const v1 = v1Blocks(input);
    expect(v1.find((b) => b.label === 'CLOSE')?.task).toBeNull();
    expect(v1.find((b) => b.label === 'MAINTAIN')?.task).toBeNull();
    const v2 = buildBriefing(input);
    expect(v2.plannerVersion).toBe(2);
    expect(v2.blocks.find((b) => b.label === 'MAINTAIN')?.state).not.toBe('omitted');
    expect(v2.blocks.find((b) => b.label === 'CLOSE')?.state).not.toBe('omitted');
    expect(v2.blocks.find((b) => b.label === 'MAINTAIN')?.nextAction).toMatch(/guest room|rental|parents|Reset/i);
    expect(v2.blocks.find((b) => b.label === 'FOCUS')?.task?.id).toBeTruthy();
  });

  it('TDLI slides already submitted are never Focus and Close only if waiting is stale', () => {
    const input = planInput({tasks: tdliSubmitted(), calendar: notConnected()});
    const v1 = v1Blocks(input);
    expect(v1.find((b) => b.label === 'FOCUS')?.task?.id).toBe('ready');
    const v2 = buildBriefing(input);
    expect(v2.blocks.map((b) => b.task?.id)).not.toContain('tdli');
    expect(v2.blocks.find((b) => b.label === 'FOCUS')?.task?.id).toBe('ready');
    expect(v2.blocks.find((b) => b.label === 'CLOSE')?.state).toBe('omitted');
    expect(v2.blocks.find((b) => b.label === 'CLOSE')?.reason).toMatch(/No grounded action found/);
  });

  it('Matt letter waiting is not an actionable Focus item', () => {
    const v2 = buildBriefing(planInput({tasks: mattLetter(), calendar: notConnected()}));
    expect(v2.blocks.map((b) => b.task?.id)).not.toContain('wait');
    expect(v2.waiting?.map((t) => t.id)).toContain('wait');
    expect(v2.topOutcomes.map((o) => o.task.id)).not.toContain('wait');
  });

  it('exhausted day uses tired sizes and skips high-energy work', () => {
    const v2 = buildBriefing(
      planInput({
        tasks: exhaustedTasks(),
        capacityMode: 'tired',
        calendar: connected(),
        events: []
      })
    );
    expect(v2.tasks.find((t) => t.id === 'keynote')?.executable).toBe(false);
    const focus = v2.blocks.find((b) => b.label === 'FOCUS');
    expect(focus?.task?.id).not.toBe('keynote');
    if (focus?.state === 'scheduled' && focus.start && focus.end) {
      const minutes = (Date.parse(focus.end) - Date.parse(focus.start)) / 60000;
      expect(minutes).toBeLessThanOrEqual(20);
    }
  });

  it('enthusiastic creative-app session grounds Expand instead of leaving it empty', () => {
    const v1 = v1Blocks(planInput({tasks: [task({id: 'ready', duration: 30})], blueprint: creativeBlueprint()}));
    expect(v1.find((b) => b.label === 'EXPAND')?.task).toBeNull();
    const v2 = buildBriefing(planInput({tasks: [task({id: 'ready', title: 'Ship the patch', duration: 30})], blueprint: creativeBlueprint(), calendar: notConnected()}));
    const expand = v2.blocks.find((b) => b.label === 'EXPAND');
    expect(expand?.state).not.toBe('omitted');
    expect(expand?.nextAction).toMatch(/creative|sketch|app/i);
    expect(expand?.provenance).toBe('suggested');
  });

  it('no outstanding Close stays explicitly empty with no filler', () => {
    const v2 = buildBriefing(planInput({tasks: [task({id: 'deep', title: 'Write the chapter', duration: 50, priority: 'High'})], calendar: notConnected()}));
    const close = v2.blocks.find((b) => b.label === 'CLOSE');
    expect(close?.state).toBe('omitted');
    expect(close?.task).toBeNull();
    expect(close?.reason).toMatch(/No grounded action found/);
    expect(close?.emptyDetail).toBeTruthy();
  });

  it('calendar absent leaves actions unscheduled and invents no times', () => {
    const v2 = buildBriefing(planInput({tasks: [task({duration: 30})], calendar: notConnected()}));
    expect(v2.blocks.every((b) => b.start === null && b.end === null)).toBe(true);
    expect(v2.blocks[0].state).toBe('unscheduled');
    expect(v2.capacity.known).toBe(false);
  });

  it('conflicting deadlines follow impact and date, not job title', () => {
    const v2 = buildBriefing(
      planInput({
        tasks: deadlineClash(),
        blueprint: {...emptyBlueprint(), nonNegotiables: ['Family admin before work'], context: ['Parents visit']},
        calendar: notConnected()
      })
    );
    expect(v2.blocks.find((b) => b.label === 'FOCUS')?.task?.id).toBe('family');
  });

  it('stale duplicates collapse and completed items never return', () => {
    const conversation = emptyConversation();
    conversation.completions.push({title: 'File the receipt', notionId: 'receipt', sourceKey: 'chat:done'});
    conversation.commitments.push({title: 'File the receipt', notionId: 'receipt', confirmed: true, sourceKey: 'chat:need', due: null});
    const input = planInput({
      tasks: [task({id: 'receipt', title: 'File the receipt', status: 'Done'}), task({id: 'ready', title: 'Ship the patch', duration: 30})],
      conversation,
      previousDigest: {
        status: 'complete',
        generatedAt: NIGHT_BEFORE.toISOString(),
        actions: [{title: 'File the receipt', due: DATE, why: 'follow up', permalink: 'mail-1', evidence: 'x'}],
        summaries: [],
        warnings: []
      }
    });
    const snap = snapshotFromPlanInput(input);
    const ids = generateCandidates(snap).map((c) => c.mergeKey);
    expect(ids.filter((k) => k.includes('receipt') || k.includes('file the receipt')).length).toBeLessThanOrEqual(1);
    const v2 = buildBriefing(input);
    expect(v2.blocks.some((b) => b.task?.id === 'receipt' || b.nextAction?.includes('File the receipt'))).toBe(false);
  });
});

describe('planner V2 plumbing', () => {
  it('projects confirmed intake without treating suggestions as tasks', () => {
    const state = projectConversation({
      ops: [{kind: 'create', status: 'succeeded', title: 'Buy cat food', pageId: 'p1', fields: {status: 'Ready'}, opKey: 'op-1'}],
      messages: [{role: 'assistant', result: {items: [{kind: 'new_task', title: 'Maybe learn cello', userConfirmed: false}]}}]
    });
    expect(state.commitments[0]).toMatchObject({title: 'Buy cat food', confirmed: true});
    expect(state.commitments.some((c) => c.title === 'Maybe learn cello' && c.confirmed)).toBe(false);
  });

  it('keeps V1 audit rejection buckets for missing duration', () => {
    const ranked = rankTasks([task({duration: null, title: 'Untitled work'})], DATE);
    const v1 = planBlocks(ranked, null);
    expect(v1.find((b) => b.label === 'CLOSE')?.reason).toMatch(/15 minutes or less/);
    expect(v1.find((b) => b.label === 'EXPAND')?.task).toBeNull();
  });

  it('records anonymized planTrace without email bodies', () => {
    const v2 = buildBriefing(
      planInput({
        tasks: parentsArrivalTasks(),
        blueprint: parentsArrivalBlueprint(),
        previousDigest: {
          status: 'complete',
          generatedAt: NIGHT_BEFORE.toISOString(),
          actions: [{title: 'Reply to school', due: DATE, why: 'needs response', permalink: 'p', evidence: 'SECRET BODY'}],
          summaries: [{subject: 'Private', from: 'a@b.com', why: 'x', permalink: 'p'}],
          warnings: []
        }
      })
    );
    const json = JSON.stringify(v2.planTrace);
    expect(json).not.toMatch(/SECRET BODY|a@b.com|Private/);
    expect(v2.planTrace?.candidateCountBySource.inbox_followups).toBe(1);
    expect(v2.planTrace?.selected).toHaveLength(4);
  });

  it('exposes the extended feedback kinds additively', () => {
    expect(FEEDBACK_KINDS).toEqual(expect.arrayContaining(['replace', 'shrink', 'skip', 'complete', 'not_relevant', 'postpone', 'explain', 'done']));
  });
});
