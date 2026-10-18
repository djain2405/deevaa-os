import {createHash} from 'node:crypto';

export function payloadHash(payload: unknown) {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Drops instruction-shaped lines from mail, pages, and other untrusted text before an agent reads it. */
export function untrustedText(text: string) {
  const kept: string[] = [];
  let stripped = false;
  for (const line of text.split(/\n/)) {
    if (/ignore (all|any|previous|prior) instructions/i.test(line) || /^\s*(system|assistant|developer)\s*:/i.test(line) || /\b(tool_call|exfiltrate|send the email now)\b/i.test(line)) {
      stripped = true;
      continue;
    }
    kept.push(line);
  }
  return {text: kept.join('\n').trim(), stripped};
}

export type ToolDecision = {decision: 'allow' | 'approval' | 'deny'; risk: 'low' | 'medium' | 'high' | 'denied'; reason: string};

const READS = new Set(['notion.read', 'gmail.read', 'calendar.read', 'github.read', 'web.read']);
const DRAFTS = new Set(['draft.create', 'notion.task.propose']);
const APPROVAL = new Set(['gmail.send', 'calendar.write', 'github.pr.open', 'publish', 'pay', 'delete.external', 'outreach.send']);
const DENY = new Set(['github.pr.merge', 'secret.disclose', 'reflection.share']);

/** Permission tiers. Merge and secret disclosure stay denied even after a click. */
export function decideTool(tool: string, ctx: {standingNotionWrite?: boolean; reflection?: boolean} = {}): ToolDecision {
  if (ctx.reflection && tool !== 'memory.read') {
    return {decision: 'deny', risk: 'denied', reason: 'Private reflections are not available to this tool.'};
  }
  if (DENY.has(tool)) return {decision: 'deny', risk: 'denied', reason: 'This action is denied.'};
  if (tool === 'notion.write') {
    return ctx.standingNotionWrite
      ? {decision: 'allow', risk: 'low', reason: 'Standing permission covers internal Notion task updates.'}
      : {decision: 'approval', risk: 'medium', reason: 'Notion writes need the standing task-update permission or a specific approval.'};
  }
  if (READS.has(tool)) return {decision: 'allow', risk: 'low', reason: 'Read-only.'};
  if (DRAFTS.has(tool)) return {decision: 'allow', risk: 'low', reason: 'Drafts stay inside Deevaa until you approve an external action.'};
  if (APPROVAL.has(tool)) return {decision: 'approval', risk: 'high', reason: 'External or destructive actions need a specific approval and still do not send on their own.'};
  return {decision: 'deny', risk: 'denied', reason: 'Unknown tool.'};
}
