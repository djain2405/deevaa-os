import {dispatchDueAgents} from '@/lib/agents/dispatch';
import {runView} from '@/lib/briefing-view';
import {bindRequest} from '@/lib/correlation';
import {apiError, bearerMatches, privateJson} from '@/lib/http';
import {logEvent} from '@/lib/log';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function statusOf(outcomes: string[]) {
  if (outcomes.includes('locked')) return 409;
  if (outcomes.includes('failed')) return 500;
  return 200;
}

/** Railway cron every 15 minutes; agents run only in their local hour. */
async function handle(req: Request) {
  if (!bearerMatches(req, process.env.CRON_SECRET)) return apiError(401, 'unauthorized', 'Invalid scheduler credentials.');
  if (!process.env.ALLOWED_EMAIL) return apiError(500, 'not_configured', 'The scheduler is not configured.');
  bindRequest(req);
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';
  const dryRun = url.searchParams.get('dry') === '1';
  const agentId = url.searchParams.get('agent') ?? undefined;
  try {
    const jobs = await dispatchDueAgents(new Date(), {force, agentId, dryRun});
    logEvent('info', 'jobs.dispatch', {count: jobs.length});
    return privateJson(
      {
        jobs: jobs.map((j) => ({
          agentId: j.agentId,
          outcome: j.outcome,
          date: j.date,
          run: runView(j.run)
        }))
      },
      statusOf(jobs.map((j) => j.outcome))
    );
  } catch (e) {
    logEvent('error', 'jobs.dispatch', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'Scheduled jobs failed.');
  }
}

export const GET = handle;
export const POST = handle;
