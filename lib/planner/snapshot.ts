import {DateTime} from 'luxon';
import type {Blueprint} from '../blueprint';
import {TIMEZONE, type CalendarEvent, type EmailDigest, type SourceHealth, type Task} from '../types';
import type {ConversationState} from './conversation-state';

export type PlannerFeedback = {taskId: string; kind: string; createdAt: string; context?: string | null};
export type PlannerApproval = {id: string; action: string; risk: string; status: string};

export type ContextSnapshot = {
  date: string;
  now: Date;
  timezone: string;
  tasks: Task[];
  events: CalendarEvent[];
  notion: SourceHealth;
  calendar: SourceHealth;
  blueprint: Blueprint | null;
  digest: EmailDigest | null;
  approvals: PlannerApproval[];
  feedback: PlannerFeedback[];
  conversation: ConversationState;
  hasPrivateMaintainSignal: boolean;
  capacityMode: 'normal' | 'tired';
  hardStop: string | null;
};

export type PlannerContextExtras = {
  timezone?: string;
  digest?: EmailDigest | null;
  approvals?: PlannerApproval[];
  feedback?: PlannerFeedback[];
  conversation?: ConversationState;
  hasPrivateMaintainSignal?: boolean;
  capacityMode?: 'normal' | 'tired';
  hardStop?: string | null;
};

const TIRED = /\b(tired|exhaust|drained|burned out|burnt out|low energy|overwhelmed|swamped)\b/i;

export function inferCapacityMode(input: {blueprint?: Blueprint | null; conversation?: ConversationState | null; energyLines?: string[]}): 'normal' | 'tired' {
  if (input.conversation?.capacityTired) return 'tired';
  const lines = [...(input.blueprint?.energy ?? []), ...(input.energyLines ?? [])];
  if (lines.some((line) => TIRED.test(line))) return 'tired';
  return 'normal';
}

export function inferHardStop(date: string, settings?: {quietStart?: string | null; timezone?: string | null} | null): string | null {
  const start = settings?.quietStart?.trim();
  if (!start || start === '22:30') return null;
  const [hour, minute] = start.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const zone = settings?.timezone || TIMEZONE;
  const dt = DateTime.fromISO(date, {zone}).set({hour, minute, second: 0, millisecond: 0});
  return dt.isValid ? dt.toISO() : null;
}

export function snapshotFromPlanInput(input: {
  date: string;
  now?: Date;
  tasks: Task[];
  events: CalendarEvent[];
  notion: SourceHealth;
  calendar: SourceHealth;
  blueprint?: Blueprint | null;
  capacityMode?: 'normal' | 'tired';
  hardStop?: string;
  timezone?: string;
  previousDigest?: EmailDigest | null;
  approvals?: PlannerApproval[];
  feedback?: PlannerFeedback[];
  conversation?: ConversationState;
  hasPrivateMaintainSignal?: boolean;
}): ContextSnapshot {
  const conversation = input.conversation ?? {
    commitments: [],
    completions: [],
    cancellations: [],
    waiting: [],
    decisions: [],
    preferences: [],
    capacityTired: false
  };
  return {
    date: input.date,
    now: input.now ?? new Date(),
    timezone: input.timezone || TIMEZONE,
    tasks: input.tasks,
    events: input.events,
    notion: input.notion,
    calendar: input.calendar,
    blueprint: input.blueprint ?? null,
    digest: input.previousDigest ?? null,
    approvals: input.approvals ?? [],
    feedback: input.feedback ?? [],
    conversation,
    hasPrivateMaintainSignal: input.hasPrivateMaintainSignal ?? false,
    capacityMode: input.capacityMode ?? inferCapacityMode({blueprint: input.blueprint, conversation}),
    hardStop: input.hardStop ?? null
  };
}

export function sourceFreshness(snapshot: ContextSnapshot): Record<string, string | null> {
  return {
    notion: snapshot.notion.lastSyncedAt,
    calendar: snapshot.calendar.lastSyncedAt,
    digest: snapshot.digest?.generatedAt ?? null,
    approvals: snapshot.approvals.length ? snapshot.now.toISOString() : null,
    feedback: snapshot.feedback[0]?.createdAt ?? null
  };
}
