import {hideEmailItem, saveEmailItemToNotion} from '@/lib/email-items';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {logEvent} from '@/lib/log';
import {getSessionUser} from '@/lib/session';
import {NotionWriteError} from '@/lib/notion-write';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {permalink?: unknown; action?: unknown} | null;
  const permalink = typeof body?.permalink === 'string' ? body.permalink : '';
  const action = body?.action;
  if (action !== 'hide' && action !== 'save') return apiError(400, 'bad_action', 'Use hide or save.');
  try {
    if (action === 'hide') {
      const item = await hideEmailItem(user.id, permalink);
      return privateJson({ok: true, action: 'hide', item: {permalink: item.permalink, kind: item.kind, pageUrl: item.pageUrl}});
    }
    const result = await saveEmailItemToNotion(user.id, permalink);
    return privateJson({
      ok: true,
      action: 'save',
      created: result.created,
      item: {permalink: result.item.permalink, kind: result.item.kind, pageUrl: result.item.pageUrl},
      task: {id: result.task.id, title: result.task.title, url: result.task.url, due: result.task.due}
    });
  } catch (e) {
    const code = e instanceof NotionWriteError ? e.code : (e as {code?: string}).code;
    if (code === 'bad_permalink') return apiError(400, 'bad_permalink', 'That is not a Gmail link from this digest.');
    if (code === 'not_in_digest') return apiError(404, 'not_in_digest', 'That message is not in today’s email digest.');
    if (code === 'writes_off') {
      return apiError(403, 'writes_off', 'Turn on Notion task updates in Connections to add this as a task.');
    }
    if (e instanceof NotionWriteError) return apiError(e.code === 'forbidden' ? 403 : 500, e.code, e.message);
    logEvent('error', 'api.gmail.item', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'Could not update that email item.');
  }
}
