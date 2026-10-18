import {calendarConflicts, prepProposals} from '@/lib/calendar-intel';
import {listNativeBlocks, proposeNativeBlock} from '@/lib/extensions';
import {fetchCalendarEvents} from '@/lib/google-calendar';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {getSessionUser} from '@/lib/session';
import {localDate} from '@/lib/time';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const date = localDate(new Date());
  const read = await fetchCalendarEvents(user.id, date);
  const blocks = await listNativeBlocks(user.id);
  return privateJson({
    date,
    health: read.health,
    events: read.events,
    conflicts: calendarConflicts(read.events),
    prep: prepProposals(read.events, new Date()).map((item) => ({...item, write: false})),
    nativeBlocks: blocks
  });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {title?: unknown; start?: unknown; end?: unknown} | null;
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const start = typeof body?.start === 'string' ? new Date(body.start) : null;
  const end = typeof body?.end === 'string' ? new Date(body.end) : null;
  if (!title || !start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return apiError(400, 'bad_block', 'Send a title, start, and end.');
  const row = await proposeNativeBlock(user.id, {title, start, end});
  return privateJson({id: row.id, status: row.status, source: row.source, googleWrite: false});
}
