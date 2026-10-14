import {Blueprint, emptyBlueprint, parseBlueprint, SUGGESTION_FIELD} from '@/lib/blueprint';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {latestBlueprint, listSuggestions, resolveSuggestion, saveBlueprint} from '@/lib/intake-store';
import {getSessionUser} from '@/lib/session';
import {audit} from '@/lib/store';

export const dynamic = 'force-dynamic';

async function view(userId: string) {
  const row = await latestBlueprint(userId);
  const suggestions = await listSuggestions(userId);
  return {
    version: row?.version ?? 0,
    updatedAt: row?.createdAt.toISOString() ?? null,
    data: row ? parseBlueprint(row.data) : emptyBlueprint(),
    suggestions: suggestions.map((s) => ({id: s.id, kind: s.kind, text: s.text, createdAt: s.createdAt.toISOString()}))
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
  return privateJson(await view(user.id));
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
    const field = SUGGESTION_FIELD[pending.kind] ?? 'context';
    if (!data[field].includes(text)) data[field] = [...data[field], text].slice(-30);
    if (!(await saveBlueprint(user.id, data, current?.version ?? 0))) return apiError(409, 'stale', 'The Blueprint changed. Try again.');
  }
  await resolveSuggestion(user.id, id, body.action === 'confirm' ? 'confirmed' : 'dismissed');
  await audit(user.id, 'blueprint.suggestion', 'ok', {action: body.action, kind: pending.kind});
  return privateJson(await view(user.id));
}
