import {runAgent} from '@/lib/agents/dispatch';
import {getAgent} from '@/lib/agents/registry';
import {briefingView, runView} from '@/lib/briefing-view';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {logEvent} from '@/lib/log';
import {getSessionUser} from '@/lib/session';
import {countRunsSince, getBriefing} from '@/lib/store';
import {localDate} from '@/lib/time';
import {BRIEFING_VERSION} from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const DAILY_LIMIT = 10;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const key = req.headers.get('idempotency-key') ?? '';
  if (!KEY.test(key)) return apiError(400, 'bad_idempotency_key', 'Send an Idempotency-Key header (8-100 letters, digits, - or _).');
  const agent = getAgent('gmail.morning');
  if (!agent) return apiError(500, 'not_configured', 'The Gmail agent is not registered.');
  try {
    if ((await countRunsSince(user.id, 'agent', new Date(Date.now() - 24 * 3600 * 1000))) >= DAILY_LIMIT) {
      return apiError(429, 'rate_limited', 'Too many Gmail digest runs today. Try again later.');
    }
    const date = localDate();
    const result = await runAgent(agent, user.id, date, 'agent', `agent:${agent.id}:${user.id}:${date}:manual:${key}`);
    const briefing = await getBriefing(user.id, date, BRIEFING_VERSION);
    const payload = {outcome: result.outcome, run: runView(result.run), briefing: briefingView(briefing)};
    if (result.outcome === 'locked') {
      return privateJson({...payload, error: {code: 'locked', message: 'A Gmail digest is already running. Try again in a minute.'}}, 409);
    }
    if (result.outcome === 'failed') {
      return privateJson({...payload, error: {code: 'failed', message: 'The Gmail digest could not be generated.'}}, 500);
    }
    return privateJson(payload);
  } catch (e) {
    logEvent('error', 'api.jobs.gmail', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'The Gmail digest could not be generated.');
  }
}
