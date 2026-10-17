import {briefingView, freshnessWarnings, getConnections, runView} from '@/lib/briefing-view';
import {listEmailItems} from '@/lib/email-items';
import {apiError, privateJson, unauthorized} from '@/lib/http';
import {logEvent} from '@/lib/log';
import {recentFeedback} from '@/lib/intake-store';
import {getSessionUser} from '@/lib/session';
import {getBriefing, latestRun} from '@/lib/store';
import {isIsoDate, localDate} from '@/lib/time';
import {BRIEFING_VERSION, type BriefingSnapshot} from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const date = new URL(req.url).searchParams.get('date') ?? localDate();
  if (!isIsoDate(date)) return apiError(400, 'bad_date', 'Use a YYYY-MM-DD date.');
  try {
    const [row, run, connections, feedback, emailItemRows] = await Promise.all([
      getBriefing(user.id, date, BRIEFING_VERSION),
      latestRun(user.id, date, {excludeTriggers: ['agent']}),
      getConnections(user.id),
      recentFeedback(user.id, new Date(Date.now() - 14 * 24 * 3600 * 1000)),
      listEmailItems(user.id)
    ]);
    const briefing = briefingView(row);
    return privateJson({
      date,
      today: localDate(),
      briefing,
      lastRun: runView(run),
      connections,
      emailItems: emailItemRows.map((r) => ({permalink: r.permalink, kind: r.kind, pageUrl: r.pageUrl})),
      feedback: feedback.map((f) => ({taskId: f.taskId, kind: f.kind, context: f.context, createdAt: f.createdAt.toISOString()})),
      warnings: briefing ? freshnessWarnings(briefing as BriefingSnapshot, run) : []
    });
  } catch (e) {
    logEvent('error', 'api.briefing.get', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'Could not load the briefing.');
  }
}
