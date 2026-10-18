export const BRIEFING_VERSION = 3;
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

export type DecisionLane =
  | 'Critical'
  | 'Due soon'
  | 'Important'
  | 'Scheduled'
  | 'Verify'
  | 'Someday'
  | 'Waiting'
  | 'Blocked'
  | 'Completed';

export type AgentWorkStatus = 'Prepared' | 'Needs approval' | 'Waiting' | 'Failed' | 'Completed';

export type AgentDeliverable = {
  agent: 'Chief of Staff' | 'Project Manager' | 'Career & Research';
  status: AgentWorkStatus;
  summary: string;
  taskIds: string[];
};
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
  tentative?: boolean;
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
export type BlockRole = 'deep_focus' | 'commitments' | 'life_logistics' | 'recovery';

/** Existing block labels stay. Roles are the blueprint names for the same four blocks. */
export const BLOCK_ROLE: Record<BlockLabel, BlockRole> = {
  FOCUS: 'deep_focus',
  CLOSE: 'commitments',
  MAINTAIN: 'life_logistics',
  EXPAND: 'recovery'
};

export type TaskRef = Pick<Task, 'id' | 'title' | 'status' | 'priority' | 'due' | 'duration' | 'url' | 'sourceLink' | 'source'> & {
  project?: string | null;
};

export type RadarItem = {
  kind: 'overdue' | 'due_soon' | 'stale_waiting' | 'blocked_deadline' | 'verify_deadline';
  task: TaskRef;
  detail: string;
};

export type BlockProvenance = 'explicit' | 'derived' | 'suggested';

export type Block = {
  label: BlockLabel;
  role?: BlockRole;
  state: 'scheduled' | 'unscheduled' | 'omitted';
  task: TaskRef | null;
  start: string | null;
  end: string | null;
  reason: string;
  aiNote?: string;
  nextAction?: string | null;
  expectedOutcome?: string | null;
  provenance?: BlockProvenance | null;
  whyNow?: string | null;
  emptyDetail?: string | null;
  candidateId?: string | null;
};

export type PlanTrace = {
  plannerVersion: 1 | 2;
  readyCount: number;
  candidateCountBySource: Record<string, number>;
  candidateCountByBlock: Record<string, number>;
  rejections: Record<string, number>;
  selected: {label: BlockLabel; candidateId: string | null}[];
  validationPasses: number;
  generationPasses: number;
  sourceFreshness: Record<string, string | null>;
};

export type RankedTask = TaskRef & {
  lane: DecisionLane;
  score: number;
  reasons: string[];
  executable: boolean;
  excludedReason: string | null;
  context: Context;
  energy: Energy;
  aiNote?: string;
};

export type EmailBucket = 'important' | 'needs_response' | 'waiting' | 'informational' | 'deadline';

export type EmailAction = {
  title: string;
  due: string | null;
  why: string;
  permalink: string;
  evidence: string;
  bucket?: EmailBucket;
  messageId?: string;
};

export type EmailSummary = {
  subject: string;
  from: string;
  why: string;
  permalink: string;
  bucket?: EmailBucket;
};

export type EmailDigest = {
  status: 'complete' | 'partial' | 'unavailable';
  generatedAt: string;
  actions: EmailAction[];
  summaries: EmailSummary[];
  warnings: string[];
  buckets?: {bucket: EmailBucket; count: number}[];
};

export type BriefingSnapshot = {
  version: typeof BRIEFING_VERSION;
  date: string;
  timezone: string;
  generatedAt: string;
  status: 'complete' | 'partial' | 'unavailable';
  summary: string;
  sources: {notion: SourceHealth; calendar: SourceHealth};
  warnings: string[];
  topOutcomes: {task: TaskRef; reasons: string[]; nextAction: string; lane: DecisionLane; aiNote?: string}[];
  blocks: Block[];
  tasks: RankedTask[];
  events: CalendarEvent[];
  capacity: {known: boolean; freeMinutes: number | null; busyMinutes: number | null; freeWindows: Interval[]};
  ai: {status: 'disabled' | 'applied' | 'rejected' | 'failed'; detail: string | null};
  /** Deadline and follow-up signals. Absent on snapshots stored before it existed. */
  radar?: RadarItem[];
  /** Waiting on others; no action until they reply. Absent on older snapshots. */
  waiting?: RankedTask[];
  /** Derived from this snapshot only — not a simulated agent run log. */
  agentWork?: AgentDeliverable[];
  /** Morning Gmail digest. Absent on snapshots stored before it existed. */
  emailDigest?: EmailDigest;
  plannerVersion?: 1 | 2;
  planTrace?: PlanTrace;
};
