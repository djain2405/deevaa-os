export type ConversationCommitment = {
  title: string;
  notionId: string | null;
  confirmed: boolean;
  sourceKey: string;
  due: string | null;
};

export type ConversationMark = {
  title: string;
  notionId: string | null;
  sourceKey: string;
};

export type ConversationState = {
  commitments: ConversationCommitment[];
  completions: ConversationMark[];
  cancellations: ConversationMark[];
  waiting: ConversationMark[];
  decisions: string[];
  preferences: string[];
  capacityTired: boolean;
};

const WAITING_PHRASE = /\b(sent for review|submitted|waiting for|waiting on|awaiting)\b/i;
const TIRED = /\b(tired|exhausted|sick|drained|low on energy|low energy|burned out|burnt out|overwhelmed|swamped)\b/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function itemList(result: unknown): Record<string, unknown>[] {
  const root = asRecord(result);
  const items = root?.items;
  return Array.isArray(items) ? items.map(asRecord).filter((x): x is Record<string, unknown> => !!x) : [];
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Projects existing chat/intake results. Does not extract from raw mail or replay journal text. */
export function projectConversation(input: {
  messages?: {role: string; result?: unknown}[];
  ops?: {kind: string; status: string; title: string; pageId?: string | null; fields?: Record<string, unknown>; opKey?: string}[];
}): ConversationState {
  const commitments: ConversationCommitment[] = [];
  const completions: ConversationMark[] = [];
  const cancellations: ConversationMark[] = [];
  const waiting: ConversationMark[] = [];
  const decisions: string[] = [];
  const preferences: string[] = [];
  let capacityTired = false;
  const seen = new Set<string>();

  const add = (list: ConversationMark[], title: string, notionId: string | null, sourceKey: string) => {
    const key = `${sourceKey}:${title.toLowerCase()}`;
    if (!title || seen.has(key)) return;
    seen.add(key);
    list.push({title, notionId, sourceKey});
  };

  for (const op of input.ops ?? []) {
    const title = op.title.trim();
    const sourceKey = op.opKey || `op:${op.title}`;
    const fields = op.fields ?? {};
    const status = text(fields.status) || op.status;
    const notionId = op.pageId ?? (typeof fields.id === 'string' ? fields.id : null);
    const due = typeof fields.due === 'string' ? fields.due : null;
    if (op.kind === 'create' && (op.status === 'succeeded' || op.status === 'proposed' || op.status === 'pending')) {
      const key = `commitment:${sourceKey}:${title.toLowerCase()}`;
      if (title && !seen.has(key)) {
        seen.add(key);
        commitments.push({title, notionId, confirmed: op.status === 'succeeded' && !!notionId, sourceKey, due});
      }
    }
    if (status === 'Done' || /completed|finished/i.test(text(fields.nextAction))) add(completions, title, notionId, sourceKey);
    if (status === 'Canceled') add(cancellations, title, notionId, sourceKey);
    if (status === 'Waiting' || status === 'Waiting for User' || WAITING_PHRASE.test(text(fields.nextAction))) add(waiting, title, notionId, sourceKey);
  }

  for (const message of input.messages ?? []) {
    if (message.role !== 'assistant') continue;
    for (const item of itemList(message.result)) {
      const title = text(item.title) || text(item.target);
      const kind = text(item.kind);
      const status = text(item.status);
      const sourceKey = text(item.evidence) ? `chat:${text(item.evidence).slice(0, 40)}` : `chat:${title}`;
      const notionId = typeof item.pageId === 'string' ? item.pageId : null;
      const due = typeof item.due === 'string' ? item.due : null;
      if (kind === 'new_task' && title) {
        const key = `commitment:${sourceKey}:${title.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          commitments.push({title, notionId, confirmed: item.userConfirmed === true && !!notionId, sourceKey, due});
        }
      }
      if (kind === 'status_update' && (status === 'Done' || status === 'Canceled')) {
        add(status === 'Done' ? completions : cancellations, title, notionId, sourceKey);
      }
      if (kind === 'status_update' && (status === 'Waiting' || status === 'Waiting for User' || WAITING_PHRASE.test(text(item.nextAction)))) {
        add(waiting, title, notionId, sourceKey);
      }
      if (kind === 'preference' && title) preferences.push(title);
      if ((kind === 'goal' || kind === 'personal_context' || kind === 'deadline') && title) decisions.push(title);
      if (kind === 'capacity' && (TIRED.test(title) || TIRED.test(text(item.evidence)))) capacityTired = true;
    }
  }

  return {commitments, completions, cancellations, waiting, decisions, preferences, capacityTired};
}

export function titleMatches(a: string, b: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}
