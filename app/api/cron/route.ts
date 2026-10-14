import {runBriefing} from '@/lib/briefing-service';
import {runView} from '@/lib/briefing-view';
import {apiError, bearerMatches, privateJson} from '@/lib/http';
import {logEvent} from '@/lib/log';
import {getOrCreateUser} from '@/lib/store';
import {tomorrowLocal} from '@/lib/time';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STATUS = {created: 200, duplicate: 200, locked: 409, kept_previous: 502, failed: 500} as const;

/** Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`; other schedulers may POST. */
async function handle(req: Request) {
  if (!bearerMatches(req, process.env.CRON_SECRET)) return apiError(401, 'unauthorized', 'Invalid scheduler credentials.');
  const email = process.env.ALLOWED_EMAIL;
  if (!email) return apiError(500, 'not_configured', 'The scheduler is not configured.');
  try {
    const user = await getOrCreateUser(email);
    const date = tomorrowLocal();
    const result = await runBriefing({userId: user.id, date, trigger: 'cron', idempotencyKey: `cron:${user.id}:${date}`});
    logEvent('info', 'cron.briefing', {outcome: result.outcome, date});
    return privateJson({outcome: result.outcome, date, run: runView(result.run)}, STATUS[result.outcome]);
  } catch (e) {
    logEvent('error', 'cron.briefing', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'Scheduled briefing failed.');
  }
}

export const GET = handle;
export const POST = handle;
