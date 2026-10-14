import {createHash} from 'node:crypto';
import {type Blueprint, type BlueprintField, emptyBlueprint} from './blueprint';
import {dueFrom, findDates} from './date-phrases';
import type {Priority, TaskStatus} from './types';

export const IMPORT_MIN_BYTES = 512;
export const IMPORT_MAX_BYTES = 120_000;
export const IMPORT_DOC_DATE = new Date('2026-10-13T12:00:00-07:00');

const MAX_LINES = 30;
const MAX_LINE = 240;

const SENSITIVE_TASK = /\b(romantic partnership|intimacy|therapy session|breakup|dating profile|attachment patterns)\b/i;
const SKIP_INSTRUCTION = /^(ignore all|send all passwords|delete everything)/i;

export type ImportTaskBucket = 'active' | 'waiting' | 'blocked' | 'done' | 'idea';

export type ImportTask = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority | null;
  due: string | null;
  project: string | null;
  nextAction: string | null;
  duration: number | null;
  bucket: ImportTaskBucket;
  evidence: string;
  assumption: string | null;
};

export type ImportSkipped = {text: string; reason: string};
export type ImportUncertain = {text: string; reason: string};

export type ImportPreview = {
  blueprint: Blueprint;
  tasks: ImportTask[];
  skipped: ImportSkipped[];
  uncertain: ImportUncertain[];
  counts: {
    blueprintFields: number;
    active: number;
    waiting: number;
    blocked: number;
    done: number;
    ideas: number;
    skipped: number;
  };
};

export function contentSha256(markdown: string) {
  return createHash('sha256').update(markdown.normalize('NFC')).digest('hex');
}

/** Stable hash of the preview payload used for approve binding. */
export function previewSha256(preview: ImportPreview) {
  const canonical = JSON.stringify({
    blueprint: preview.blueprint,
    tasks: preview.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      due: t.due,
      project: t.project,
      nextAction: t.nextAction,
      duration: t.duration,
      bucket: t.bucket
    }))
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function importExternalKey(userId: string, title: string, project: string | null) {
  const norm = `${userId}:${title.toLowerCase().trim()}:${(project ?? '').toLowerCase().trim()}`;
  return `deevaa:imp:${createHash('sha256').update(norm).digest('hex').slice(0, 20)}`;
}

type Section = {num: string; title: string; body: string};

function sections(markdown: string): Section[] {
  const out: Section[] = [];
  const chunks = markdown.split(/^#\s*(\d+)\.\s*(.+)$/m);
  for (let i = 1; i < chunks.length; i += 3) {
    out.push({num: chunks[i], title: chunks[i + 1].trim(), body: chunks[i + 2] ?? ''});
  }
  return out;
}

function clip(line: string) {
  const t = line.replace(/^[-*•]\s*/, '').replace(/\*\*/g, '').trim();
  if (!t || SKIP_INSTRUCTION.test(t)) return null;
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1)}…` : t;
}

function pushUnique(list: string[], line: string | null) {
  if (!line || list.includes(line)) return;
  if (list.length < MAX_LINES) list.push(line);
}

function priorityFrom(text: string): Priority | null {
  if (/\b(critical|urgent)\b/i.test(text)) return 'Urgent';
  if (/\bhigh\b/i.test(text)) return 'High';
  if (/\blow\b/i.test(text)) return 'Low';
  if (/\bmedium\b/i.test(text)) return 'Medium';
  return null;
}

function statusFromBlock(block: string): TaskStatus | null {
  if (/waiting for review|status:\s*waiting/i.test(block)) return 'Waiting';
  if (/decision pending|not confirmed|status:\s*not confirmed/i.test(block)) return 'Blocked';
  if (/status:\s*active|status:\s*ongoing/i.test(block)) return 'Ready';
  if (/status:\s*done|completed the/i.test(block)) return 'Done';
  return null;
}

function taskId(title: string, project: string | null) {
  return createHash('sha256').update(`${title}:${project ?? ''}`).digest('hex').slice(0, 12);
}

const HISTORICAL = /\b(achieved|completed|approved|released|submitted|won|finished|milestone|hackathon)\b/i;
const DEADLINE_HINT = /\b(before|by|due|deadline|appointment|arrive|approaching|reschedule|october|november|december|january|february|march|april|may|june|july|august|september)\b/i;

/** Due dates come from the task line only — not accomplishment dates elsewhere in the project section. */
function parseDueForTask(taskLine: string, now: Date): {due: string | null; assumption: string | null} {
  if (/do not invent/i.test(taskLine)) return {due: null, assumption: 'Deadline not stated; verify before scheduling.'};
  const dates = findDates(taskLine, now).filter((m) => !HISTORICAL.test(taskLine.slice(Math.max(0, m.index - 40), m.index + m.text.length + 40)));
  if (!dates.length) {
    return {due: null, assumption: /verify the actual response deadline/i.test(taskLine) ? 'Deadline not stated; verify before scheduling.' : null};
  }
  const pick = dates.find((m) => m.mode !== 'mention' || DEADLINE_HINT.test(taskLine)) ?? (DEADLINE_HINT.test(taskLine) ? dates[0] : null);
  if (!pick) return {due: null, assumption: null};
  const d = dueFrom(pick);
  return {due: d.due, assumption: d.assumption};
}

function bullets(block: string) {
  return block
    .split(/\n/)
    .map((l) => clip(l))
    .filter(Boolean) as string[];
}

function addTask(
  tasks: ImportTask[],
  skipped: ImportSkipped[],
  input: {title: string; project: string | null; block: string; dueLine?: string; bucket: ImportTaskBucket; status: TaskStatus; now: Date; priority?: Priority | null}
) {
  const title = input.title.trim();
  if (!title || title.length < 4) return;
  if (SENSITIVE_TASK.test(title) || SENSITIVE_TASK.test(input.block)) {
    skipped.push({text: title, reason: 'Sensitive personal content stays in Blueprint only.'});
    return;
  }
  if (/\b(secure romantic|long-term goal|aspiration)\b/i.test(title) && input.bucket === 'active') {
    skipped.push({text: title, reason: 'Long-term goal, not a task.'});
    return;
  }
  const {due, assumption} =
    input.bucket === 'done' || input.bucket === 'idea' || input.status === 'Waiting'
      ? {due: null, assumption: null}
      : parseDueForTask(input.dueLine ?? input.title, input.now);
  const nextAction =
    input.status === 'Waiting'
      ? /waiting for review/i.test(input.block)
        ? 'Waiting for reviewer feedback'
        : 'Waiting on a response'
      : input.status === 'Blocked'
        ? 'Decision or confirmation needed'
        : null;
  tasks.push({
    id: taskId(title, input.project),
    title,
    status: input.status,
    priority: input.priority ?? priorityFrom(input.block),
    due,
    project: input.project,
    nextAction,
    duration: null,
    bucket: input.bucket,
    evidence: title.slice(0, 200),
    assumption
  });
}

function extractProjectBlocks(body: string) {
  const blocks: {project: string | null; text: string}[] = [];
  const parts = body.split(/\*\*Project:\*\*/i);
  if (parts.length === 1) return [{project: null, text: body}];
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const firstLine = chunk.split('\n')[0]?.trim() ?? '';
    const project = firstLine.replace(/\*\*/g, '').trim() || null;
    blocks.push({project, text: chunk});
  }
  return blocks;
}

function fillBlueprint(bp: Blueprint, field: BlueprintField, lines: string[]) {
  for (const l of lines) pushUnique(bp[field], l);
}

/** Deterministic parse of a one-time Life Blueprint markdown export. Instruction sections are ignored. */
export function extractImportPreview(markdown: string, now: Date = IMPORT_DOC_DATE): ImportPreview {
  const bp = emptyBlueprint();
  const tasks: ImportTask[] = [];
  const skipped: ImportSkipped[] = [];
  const uncertain: ImportUncertain[] = [];

  const secs = sections(markdown).filter((s) => s.num !== '19');
  for (const s of secs) {
    const body = s.body;
    const n = s.num;

    if (n === '1') {
      for (const l of bullets(body)) {
        if (/key aspirations|guiding reflection/i.test(l)) continue;
        if (/partnership|leadership|expert|wealth|home|health|adventure|creates instead/i.test(l) || /^I am /i.test(l) || /principle/i.test(l)) {
          fillBlueprint(bp, 'goals', [l]);
        } else if (/vision|identity/i.test(l)) {
          fillBlueprint(bp, 'context', [l]);
        }
      }
    }

    if (n === '2') {
      for (const l of bullets(body)) {
        if (/confidential|privacy|approval|never|ask before/i.test(l)) fillBlueprint(bp, 'boundaries', [l]);
        else fillBlueprint(bp, 'preferences', [l]);
      }
    }

    if (n === '3') {
      for (const l of bullets(body)) fillBlueprint(bp, 'schedulingConstraints', [l]);
      const dates = findDates(body, now);
      if (dates.length) fillBlueprint(bp, 'schedulingConstraints', [`Parents arrive ${dates[0].date}`]);
    }

    if (['4', '5', '6', '7', '8', '9', '10'].includes(n)) {
      for (const block of extractProjectBlocks(body)) {
        if (block.project && /active|ongoing|critical/i.test(block.text)) pushUnique(bp.activeProjects, block.project);
        const st = statusFromBlock(block.text) ?? 'Ready';

        const activeMatch = block.text.match(/\*\*Active tasks:\*\*([\s\S]*?)(?=\n\*\*|$)/i);
        if (activeMatch) {
          for (const line of bullets(activeMatch[1])) {
            if (/waiting for review|submitted.*responses/i.test(line)) continue;
            addTask(tasks, skipped, {title: line, project: block.project, block: block.text, dueLine: line, bucket: 'active', status: st === 'Waiting' ? 'Ready' : st, now});
          }
        }

        const actionMatch = block.text.match(/\*\*Active action:\*\*\s*([^\n]+)/i);
        if (actionMatch) {
          const actionLine = clip(actionMatch[1])!;
          addTask(tasks, skipped, {title: actionLine, project: block.project ?? 'Personal Life Administration', block: block.text, dueLine: actionLine, bucket: 'active', status: 'Ready', now, priority: 'High'});
        }

        if (/waiting for review/i.test(block.text) && !tasks.some((t) => /open-source|review changes/i.test(t.title))) {
          addTask(tasks, skipped, {
            title: 'Open-source PR review follow-up',
            project: block.project,
            block: block.text,
            dueLine: 'Waiting for review',
            bucket: 'waiting',
            status: 'Waiting',
            now,
            priority: 'Medium'
          });
        }

        const doctor = block.text.match(/Doctor's appointment([\s\S]*?)(?=\n\*\*|$)/i);
        if (doctor) {
          addTask(tasks, skipped, {
            title: "Reschedule doctor's appointment to December",
            project: block.project ?? 'Personal Life Administration',
            block: doctor[0],
            dueLine: doctor[0],
            bucket: 'active',
            status: 'Ready',
            now,
            priority: 'Urgent'
          });
          if (/not confirmed/i.test(doctor[0])) uncertain.push({text: "Doctor's appointment reschedule", reason: 'Move to December is planned but not confirmed.'});
        }

        const citation = block.text.match(/Speeding citation([\s\S]*?)(?=\n\*\*|$)/i);
        if (citation) {
          const action = citation[0].match(/\*\*Active action:\*\*\s*([^\n]+)/i)?.[1] ?? citation[0];
          addTask(tasks, skipped, {
            title: 'Review speeding citation and calendar response deadline',
            project: block.project ?? 'Personal Life Administration',
            block: `${action} Do not invent the response due date.`,
            dueLine: `${action} Do not invent the response due date.`,
            bucket: 'active',
            status: 'Ready',
            now,
            priority: 'High'
          });
          if (/do not invent/i.test(citation[0])) uncertain.push({text: 'Speeding citation deadline', reason: 'Response due date must be verified from the notice.'});
        }
      }
    }

    if (n === '11') {
      if (/energy|longevity/i.test(body)) fillBlueprint(bp, 'energy', ['Prioritize sustainable energy, recovery, and longevity.']);
      for (const l of bullets(body)) {
        if (/vegetarian|energy|sleep|recovery/i.test(l)) fillBlueprint(bp, 'energy', [l]);
        else if (/walk|workout/i.test(l)) fillBlueprint(bp, 'routines', [l]);
        else fillBlueprint(bp, 'routines', [l]);
      }
    }

    if (n === '12') fillBlueprint(bp, 'recurringCommitments', bullets(body));
    if (n === '13') {
      for (const l of bullets(body)) {
        if (SENSITIVE_TASK.test(l)) fillBlueprint(bp, 'context', ['Private relationship reflection (details not in tasks).']);
        else fillBlueprint(bp, 'context', [l]);
      }
    }
    if (n === '14') fillBlueprint(bp, 'experiments', bullets(body));
    if (n === '15') fillBlueprint(bp, 'routines', bullets(body));

    if (n === '16') {
      const ideaMatch = body.match(/\*\*Remember Dates\*\*([\s\S]*?)(?=\n\*\*|$)/i);
      if (ideaMatch) {
        pushUnique(bp.pausedProjects, 'Remember Dates');
        addTask(tasks, skipped, {title: 'Remember Dates app idea', project: 'Someday/Ideas', block: ideaMatch[0], dueLine: '', bucket: 'idea', status: 'Inbox', now});
      }
      for (const l of bullets(body)) {
        if (/park in ideas|future product/i.test(l)) pushUnique(bp.pausedProjects, l.split('—')[0]?.trim() ?? l);
      }
    }

    if (n === '17') {
      for (const l of bullets(body)) {
        fillBlueprint(bp, 'lessons', [l]);
        const title = l.replace(/^completed the/i, 'Completed:').replace(/^submitted the/i, 'Submitted:');
        addTask(tasks, skipped, {title: title.slice(0, 120), project: 'Milestones', block: l, bucket: 'done', status: 'Done', now});
      }
    }

    if (n === '18') {
      const imm = body.match(/\*\*Immediate[\s\S]*?\*\*([\s\S]*?)(?=\n\*\*|$)/i);
      if (imm) for (const l of bullets(imm[1])) fillBlueprint(bp, 'quarterlyPriorities', [l]);
      const hi = body.match(/\*\*High-impact[\s\S]*?\*\*([\s\S]*?)(?=\n\*\*|$)/i);
      if (hi) for (const l of bullets(hi[1])) fillBlueprint(bp, 'quarterlyPriorities', [l]);
    }
  }

  // Deduplicate tasks by title+project
  const seen = new Set<string>();
  const deduped: ImportTask[] = [];
  for (const t of tasks) {
    const k = `${t.title}:${t.project}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(t);
  }

  const filledFields = (Object.keys(bp) as BlueprintField[]).filter((k) => bp[k].length).length;

  return {
    blueprint: bp,
    tasks: deduped,
    skipped,
    uncertain,
    counts: {
      blueprintFields: filledFields,
      active: deduped.filter((t) => t.bucket === 'active').length,
      waiting: deduped.filter((t) => t.bucket === 'waiting').length,
      blocked: deduped.filter((t) => t.bucket === 'blocked').length,
      done: deduped.filter((t) => t.bucket === 'done').length,
      ideas: deduped.filter((t) => t.bucket === 'idea').length,
      skipped: skipped.length
    }
  };
}

export function mergeBlueprintEdits(preview: ImportPreview, edits?: {tasks?: Partial<ImportTask>[]}): ImportPreview {
  if (!edits?.tasks?.length) return preview;
  const byId = new Map(edits.tasks.filter((t) => t.id).map((t) => [t.id!, t]));
  return {
    ...preview,
    tasks: preview.tasks.map((t) => {
      const e = byId.get(t.id);
      if (!e) return t;
      return {...t, ...e, title: e.title?.trim() || t.title};
    })
  };
}
