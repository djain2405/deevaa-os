import {Blueprint, blueprintHasContent, emptyBlueprint, parseBlueprint, SUGGESTION_FIELD} from '@/lib/blueprint';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {wipeBlueprintData} from '@/lib/import-store';
import {latestBlueprint, listSuggestions, resolveSuggestion, saveBlueprint} from '@/lib/intake-store';
import {getSessionUser} from '@/lib/session';
import {notionPagePublicUrl, publishLifeBlueprintToNotion, restoreLifeBlueprintFromNotion} from '@/lib/notion-blueprint';
import {logEvent} from '@/lib/log';
import {audit, getBlueprintNotionPageId} from '@/lib/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

async function view(userId: string) {
  const existing = await latestBlueprint(userId);
  let restoredFromNotion = false;
  if (!existing || !blueprintHasContent(parseBlueprint(existing.data))) {
    const restored = await restoreLifeBlueprintFromNotion(userId).catch((e) => {
      logEvent('warn', 'blueprint.view.restore', {kind: e instanceof Error ? e.name : 'unknown'});
      return {status: 'failed' as const, pageId: null};
    });
    restoredFromNotion = restored.status === 'restored';
  }
  const row = await latestBlueprint(userId);
  const suggestions = await listSuggestions(userId);
  let notionPageId: string | null = null;
  try {
    notionPageId = await getBlueprintNotionPageId(userId);
  } catch (e) {
    logEvent('warn', 'blueprint.view.notion_page', {kind: e instanceof Error ? e.name : 'unknown'});
  }
  return {
    version: row?.version ?? 0,
    updatedAt: row?.createdAt.toISOString() ?? null,
    data: row ? parseBlueprint(row.data) : emptyBlueprint(),
    suggestions: suggestions.map((s) => ({id: s.id, kind: s.kind, text: s.text, createdAt: s.createdAt.toISOString()})),
    notionPageUrl: notionPageId ? notionPagePublicUrl(notionPageId) : null,
    restoredFromNotion
  };
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  return privateJson(await view(user.id));
}

/** Saves an edited Blueprint as a new version. Also used for a one-time seed import the user has reviewed. */
export async function PUT(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {version?: unknown; data?: unknown} | null;
  if (typeof body?.version !== 'number') return apiError(400, 'bad_version', 'Send the version you edited.');
  const parsed = Blueprint.safeParse(body.data);
  if (!parsed.success) return apiError(400, 'bad_blueprint', 'Each section takes up to 30 lines of up to 240 characters.');
  const row = await saveBlueprint(user.id, parsed.data, body.version);
  if (!row) return apiError(409, 'stale', 'The Blueprint changed since you opened it. Reload and try again.');
  await audit(user.id, 'blueprint.save', 'ok', {version: row.version});
  let notion = await publishLifeBlueprintToNotion(user.id, parsed.data).catch((e) => {
    logEvent('error', 'blueprint.publish', {kind: e instanceof Error ? e.name : 'unknown'});
    return {status: 'failed' as const, url: null, message: 'Could not publish Life Blueprint to Notion.'};
  });
  try {
    return privateJson({...(await view(user.id)), notion});
  } catch (e) {
    logEvent('error', 'blueprint.put.response', {kind: e instanceof Error ? e.name : 'unknown'});
    return privateJson({
      version: row.version,
      updatedAt: row.createdAt.toISOString(),
      data: parsed.data,
      suggestions: [],
      notionPageUrl: null,
      notion
    });
  }
}

/** Confirms or dismisses a note Deevaa inferred from chat. Only confirmed notes reach the planner. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {id?: unknown; action?: unknown; text?: unknown} | null;
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!/^[0-9a-f-]{36}$/i.test(id) || (body?.action !== 'confirm' && body?.action !== 'dismiss')) return apiError(400, 'bad_request', 'Send a suggestion id and confirm or dismiss.');
  const pending = (await listSuggestions(user.id)).find((s) => s.id === id);
  if (!pending) return apiError(404, 'not_found', 'That note was already reviewed.');
  if (body.action === 'confirm') {
    const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 240) : pending.text.slice(0, 240);
    const current = await latestBlueprint(user.id);
    const data = current ? parseBlueprint(current.data) : emptyBlueprint();
    const field = pending.kind === 'boundary' ? 'boundaries' : SUGGESTION_FIELD[pending.kind] ?? 'context';
    if (!data[field].includes(text)) data[field] = [...data[field], text].slice(-30);
    if (!(await saveBlueprint(user.id, data, current?.version ?? 0))) return apiError(409, 'stale', 'The Blueprint changed. Try again.');
  }
  await resolveSuggestion(user.id, id, body.action === 'confirm' ? 'confirmed' : 'dismissed');
  await audit(user.id, 'blueprint.suggestion', 'ok', {action: body.action, kind: pending.kind});
  return privateJson(await view(user.id));
}

/** Deletes Blueprint versions, pending suggestions, and import previews. Notion tasks are unchanged. */
export async function DELETE(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  await wipeBlueprintData(user.id);
  await audit(user.id, 'blueprint.wipe', 'ok');
  return privateJson({deleted: true});
}
