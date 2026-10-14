import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {undoMessage} from '@/lib/intake';
import {getMessage} from '@/lib/intake-store';
import {logEvent} from '@/lib/log';
import {readMessageId} from '@/lib/route-helpers';
import {getSessionUser} from '@/lib/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const parsed = await readMessageId(req);
  if ('error' in parsed) return parsed.error;
  if (!(await getMessage(user.id, parsed.id))) return apiError(404, 'not_found', 'That message was not found.');
  try {
    const r = await undoMessage(user.id, parsed.id);
    if (r.outcome === 'forbidden') return apiError(403, 'writes_off', 'Turn on Notion updates to undo changes.');
    if (r.outcome === 'locked') return apiError(409, 'locked', 'Another update is running. Try again in a moment.');
    if (r.outcome === 'failed') return apiError(502, 'notion_unavailable', r.message);
    return privateJson(r);
  } catch (e) {
    logEvent('error', 'api.chat.undo', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'The changes could not be undone.');
  }
}
