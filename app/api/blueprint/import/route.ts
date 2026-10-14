import {contentSha256, extractImportPreview, IMPORT_MAX_BYTES, IMPORT_MIN_BYTES, previewSha256} from '@/lib/blueprint-import';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {countImportsSince, findAppliedImport, upsertImportPreview} from '@/lib/import-store';
import {logEvent} from '@/lib/log';
import {getSessionUser} from '@/lib/session';
import {audit} from '@/lib/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const HOURLY = 5;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const body = (await req.json().catch(() => null)) as {sourceName?: unknown; markdown?: unknown} | null;
  const markdown = typeof body?.markdown === 'string' ? body.markdown : '';
  const sourceName = typeof body?.sourceName === 'string' && body.sourceName.trim() ? body.sourceName.trim().slice(0, 200) : 'life-blueprint-import.md';
  const bytes = new TextEncoder().encode(markdown).length;
  if (bytes < IMPORT_MIN_BYTES) return apiError(400, 'too_short', 'Paste your full Life Blueprint export (at least a few paragraphs).');
  if (bytes > IMPORT_MAX_BYTES) return apiError(413, 'too_large', 'That file is too large for one import.');

  try {
    if ((await countImportsSince(user.id, new Date(Date.now() - 3600 * 1000))) >= HOURLY) {
      return apiError(429, 'rate_limited', 'Too many import previews this hour. Try again later.');
    }
    const hash = contentSha256(markdown);
    const priorApplied = await findAppliedImport(user.id, hash);
    const preview = extractImportPreview(markdown);
    const pHash = previewSha256(preview);
    const row = await upsertImportPreview({userId: user.id, sourceName, contentSha256: hash, previewSha256: pHash, preview});
    await audit(user.id, 'blueprint.import.preview', 'ok', {importId: row.id, counts: preview.counts.blueprintFields});
    logEvent('info', 'blueprint.import.preview', {importId: row.id, fields: preview.counts.blueprintFields, tasks: preview.tasks.length});
    return privateJson({
      id: row.id,
      previewSha256: pHash,
      contentSha256: hash,
      sourceName,
      preview,
      previouslyApplied: Boolean(priorApplied),
      note: priorApplied
        ? 'You imported this file before. This is a fresh preview (e.g. after due-date fixes). Approve again to update matching Notion tasks; clear wrong dues in Notion if needed.'
        : null
    });
  } catch (e) {
    logEvent('error', 'blueprint.import.preview', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'Could not build an import preview.');
  }
}
