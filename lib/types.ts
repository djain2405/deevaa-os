export const BRIEFING_VERSION = 2;
export const TIMEZONE = 'America/Los_Angeles';

export type TaskStatus =
  | 'Inbox'
  | 'Ready'
  | 'In Progress'
  | 'Waiting'
  | 'Waiting for User'
  | 'Blocked'
  | 'Done'
  | 'Canceled'
  | 'Needs Verification';

export type Priority = 'Urgent' | 'High' | 'Medium' | 'Low' | 'None';
export type Energy = 'Low' | 'Medium' | 'High';
export type Context = 'Anywhere' | 'Phone' | 'Laptop' | 'Home';

export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  rawStatus: string | null;
  priority: Priority;
  due: string | null;
  /** Minutes. Null when Notion has no estimate; the planner never invents one for short windows. */
  duration: number | null;
  context: Context;
  energy: Energy;
  blocker: string | null;
  blockedBy: string[];
  externalKey: string | null;
  project: string | null;
  nextAction: string | null;
  url: string;
  sourceLink: string | null;
  source: 'notion';
  lastEditedAt: string;
};

export type CalendarEvent = {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  busy: boolean;
  htmlLink: string | null;
  source: 'google_calendar';
};

export type SourceState = 'connected' | 'not_connected' | 'error';

export type SourceHealth = {
  state: SourceState;
  /** User-facing, never a provider error body. */
  message: string;
  lastSyncedAt: string | null;
  count: number;
  warnings: string[];
};

export type Interval = {start: string; end: string};

export type BlockLabel = 'FOCUS' | 'CLOSE' | 'MAINTAIN' | 'EXPAND';

export type TaskRef = Pick<Task, 'id' | 'title' | 'status' | 'priority' | 'due' | 'duration' | 'url' | 'sourceLink' | 'source'> & {
  project?: string | null;
};

export type RadarItem = {
  kind: 'overdue' | 'due_soon' | 'stale_waiting' | 'blocked_deadline';
  task: TaskRef;
  detail: string;
};

export type Block = {
  label: BlockLabel;
  state: 'scheduled' | 'unscheduled' | 'omitted';
  task: TaskRef | null;
  start: string | null;
  end: string | null;
  reason: string;
  aiNote?: string;
};

export type RankedTask = TaskRef & {
  score: number;
  reasons: string[];
  executable: boolean;
  excludedReason: string | null;
  context: Context;
  energy: Energy;
  aiNote?: string;
};

export type BriefingSnapshot = {
  version: typeof BRIEFING_VERSION;
  date: string;
  timezone: typeof TIMEZONE;
  generatedAt: string;
  status: 'complete' | 'partial' | 'unavailable';
  summary: string;
  sources: {notion: SourceHealth; calendar: SourceHealth};
  warnings: string[];
  topOutcomes: {task: TaskRef; reasons: string[]; aiNote?: string}[];
  blocks: Block[];
  tasks: RankedTask[];
  events: CalendarEvent[];
  capacity: {known: boolean; freeMinutes: number | null; busyMinutes: number | null; freeWindows: Interval[]};
  ai: {status: 'disabled' | 'applied' | 'rejected' | 'failed'; detail: string | null};
  /** Deadline and follow-up signals. Absent on snapshots stored before it existed. */
  radar?: RadarItem[];
};
