import {emptyBlueprint, type Blueprint} from '@/lib/blueprint';
import type {ConversationState} from '@/lib/planner/conversation-state';
import type {PlanInput} from '@/lib/planner';
import {connected, task} from '../helpers';

export const DATE = '2026-10-14';
export const NIGHT_BEFORE = new Date('2026-10-14T05:00:00Z');

export const emptyConversation = (): ConversationState => ({
  commitments: [],
  completions: [],
  cancellations: [],
  waiting: [],
  decisions: [],
  preferences: [],
  capacityTired: false
});

export function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  const tasks = overrides.tasks ?? [task()];
  return {
    date: DATE,
    now: NIGHT_BEFORE,
    tasks,
    events: overrides.events ?? [],
    notion: overrides.notion ?? connected(tasks.length),
    calendar: overrides.calendar ?? connected(overrides.events?.length ?? 0),
    conversation: emptyConversation(),
    ...overrides
  };
}

export const parentsArrivalBlueprint = (): Blueprint => ({
  ...emptyBlueprint(),
  context: ['Parents arrive Friday', 'Road trip this weekend'],
  nonNegotiables: ['Host parents well'],
  routines: ['Reset the guest room'],
  recurringCommitments: ['Confirm the rental car']
});

export const parentsArrivalTasks = () => [
  task({id: 'report', title: 'Write weekly status report', priority: 'High', duration: 45}),
  task({id: 'guest', title: 'Prepare the guest room', priority: 'Medium', duration: null, context: 'Home'}),
  task({id: 'car', title: 'Confirm the rental car', priority: 'High', duration: null})
];

export const tdliSubmitted = () => [
  task({id: 'tdli', title: 'TDLI slides', status: 'Waiting', priority: 'Urgent', lastEditedAt: '2026-10-13T00:00:00Z', nextAction: 'Submitted — waiting on the response'}),
  task({id: 'ready', title: 'Ship the patch', priority: 'Medium', duration: 30})
];

export const mattLetter = () => [
  task({id: 'wait', title: "Matt's letter", status: 'Waiting', priority: 'High', nextAction: 'Waiting on Matt', lastEditedAt: '2026-10-13T12:00:00Z'}),
  task({id: 'ready', title: 'Ship fix', priority: 'Medium', duration: 30})
];

export const exhaustedTasks = () => [
  task({id: 'keynote', title: 'Write the keynote', duration: 90, energy: 'High', priority: 'Urgent'}),
  task({id: 'receipt', title: 'File the receipt', duration: 10, energy: 'Low'}),
  task({id: 'walk', title: 'Evening walk', duration: 20, energy: 'Low', context: 'Home'})
];

export const creativeBlueprint = (): Blueprint => ({
  ...emptyBlueprint(),
  goals: ['Ship a creative drawing app'],
  experiments: ['Daily sketch in the new app']
});

export const deadlineClash = () => [
  task({id: 'job', title: 'Staff engineer interview loop', priority: 'High', due: '2026-10-20', duration: 45}),
  task({id: 'family', title: 'Renew parents’ visitor insurance', priority: 'High', due: DATE, duration: 30, context: 'Home'})
];
