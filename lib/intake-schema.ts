import {z} from 'zod';

export const ITEM_KINDS = [
  'new_task',
  'status_update',
  'project',
  'deadline',
  'goal',
  'preference',
  'personal_context',
  'reflection',
  'capacity',
  'none'
] as const;

export const WRITABLE_STATUSES = ['Inbox', 'Ready', 'In Progress', 'Waiting', 'Blocked', 'Done', 'Canceled'] as const;

export const ExtractedItem = z.strictObject({
  kind: z.enum(ITEM_KINDS),
  /** Task title for tasks; a short note for everything else. */
  title: z.string().trim().min(1).max(200),
  /** Exact quote from the message. Items whose evidence is not in the message are dropped. */
  evidence: z.string().trim().min(1).max(500),
  /** For status updates: the words that identify the existing task. */
  target: z.string().trim().max(200).nullable(),
  status: z.enum(WRITABLE_STATUSES).nullable(),
  dueText: z.string().trim().max(100).nullable(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  priority: z.enum(['Urgent', 'High', 'Medium', 'Low']).nullable(),
  durationMinutes: z.number().int().min(1).max(600).nullable(),
  project: z.string().trim().max(100).nullable(),
  nextAction: z.string().trim().max(200).nullable(),
  /** True only when the user explicitly states the fact, e.g. "I submitted it". */
  userConfirmed: z.boolean(),
  assumption: z.string().trim().max(240).nullable()
});
export type ExtractedItem = z.infer<typeof ExtractedItem>;

export const Extraction = z.strictObject({
  items: z.array(ExtractedItem).max(12),
  reply: z.string().max(600),
  clarifications: z.array(z.string().max(240)).max(3)
});
export type Extraction = z.infer<typeof Extraction>;

export const item = (overrides: Partial<ExtractedItem> & Pick<ExtractedItem, 'kind' | 'title' | 'evidence'>): ExtractedItem => ({
  target: null,
  status: null,
  dueText: null,
  due: null,
  priority: null,
  durationMinutes: null,
  project: null,
  nextAction: null,
  userConfirmed: false,
  assumption: null,
  ...overrides
});
