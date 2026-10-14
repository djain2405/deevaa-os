import {previewSha256, type ImportPreview} from '@/lib/blueprint-import';
import {applyImportPreview} from '@/lib/import-apply';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {findAppliedImport, getImportPreview, markImportApplied} from '@/lib/import-store';
import {logEvent} from '@/lib/log';
import {getSessionUser} from '@/lib/session';
import {audit} from '@/lib/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const body = (await req.json().catch(() => null)) as {id?: unknown; previewSha256?: unknown; tasks?: unknown} | null;
  const id = typeof body?.id === 'string' ? body.id : '';
  const expected = typeof body?.previewSha256 === 'string' ? body.previewSha256 : '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError(400, 'bad_request', 'Send the preview id.');

  try {
    const row = await getImportPreview(user.id, id);
    if (!row || row.status !== 'preview') return apiError(404, 'not_found', 'That import preview is no longer available.');
    let preview = row.preview as ImportPreview;
    if (Array.isArray(body?.tasks)) {
      preview = {...preview, tasks: body.tasks as ImportPreview['tasks']};
    }
    const hash = previewSha256(preview);
    if (!Array.isArray(body?.tasks)) {
      if (expected && hash !== expected) return apiError(409, 'stale', 'The preview changed. Reload and approve again.');
      if (!expected && hash !== row.previewSha256) return apiError(409, 'stale', 'The preview changed. Reload and approve again.');
    }

    const result = await applyImportPreview(user.id, preview, hash);
    if (result.outcome === 'stale') return apiError(409, 'stale', result.message);

    await markImportApplied(user.id, id, {outcome: result.outcome, counts: result.counts, items: result.items.map((i) => ({action: i.action, taskId: i.taskId}))});
    await audit(user.id, 'blueprint.import.apply', result.outcome === 'failed' ? 'error' : 'ok', {outcome: result.outcome, created: result.items.filter((i) => i.action === 'created').length});
    logEvent('info', 'blueprint.import.apply', {importId: id, outcome: result.outcome});
    return privateJson(result);
  } catch (e) {
    logEvent('error', 'blueprint.import.apply', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'The import could not be applied.');
  }
}
