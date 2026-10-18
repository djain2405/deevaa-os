import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {getSessionUser} from '@/lib/session';
import {listLifeAreas, updateLifeArea} from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const areas = await listLifeAreas(user.id);
  return privateJson({areas: areas.map((a) => ({slug: a.slug, name: a.name, visibility: a.visibility, archived: a.archived, sortOrder: a.sortOrder}))});
}

export async function PUT(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {slug?: unknown; name?: unknown; visibility?: unknown; archived?: unknown} | null;
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  if (!slug) return apiError(400, 'bad_area', 'Name the life area to update.');
  const visibility = body?.visibility === 'work' || body?.visibility === 'private' ? body.visibility : undefined;
  const row = await updateLifeArea(user.id, slug, {
    name: typeof body?.name === 'string' ? body.name : undefined,
    visibility,
    archived: typeof body?.archived === 'boolean' ? body.archived : undefined
  });
  if (!row) return apiError(404, 'missing_area', 'That life area is not on your list.');
  return privateJson({slug: row.slug, name: row.name, visibility: row.visibility, archived: row.archived});
}
