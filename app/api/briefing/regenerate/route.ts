import {runBriefing} from '@/lib/briefing-service';
import {briefingView, runView} from '@/lib/briefing-view';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {logEvent} from '@/lib/log';
import {getSessionUser} from '@/lib/session';
import {countRunsSince} from '@/lib/store';
import {localDate, tomorrowLocal} from '@/lib/time';

export const dynamic = 'force-dynamic';

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const DAILY_LIMIT = 30;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const key = req.headers.get('idempotency-key') ?? '';
  if (!KEY.test(key)) return apiError(400, 'bad_idempotency_key', 'Send an Idempotency-Key header (8-100 letters, digits, - or _).');

  const body = (await req.json().catch(() => ({}))) as {date?: unknown};
  const date = typeof body.date === 'string' ? body.date : localDate();
  if (date !== localDate() && date !== tomorrowLocal()) return apiError(400, 'bad_date', 'Only today or tomorrow can be regenerated.');

  try {
    const trigger = key.startsWith('initial-') ? 'initial' : 'manual';
    if ((await countRunsSince(user.id, trigger, new Date(Date.now() - 24 * 3600 * 1000))) >= DAILY_LIMIT) {
      return apiError(429, 'rate_limited', 'Too many regenerations today. Try again later.');
    }
    const result = await runBriefing({userId: user.id, date, trigger, idempotencyKey: `${trigger}:${user.id}:${date}:${key}`});
    const payload = {outcome: result.outcome, run: runView(result.run), briefing: briefingView(result.briefing)};
    if (result.outcome === 'locked') return privateJson({...payload, error: {code: 'locked', message: 'A briefing is already being prepared. Try again in a minute.'}}, 409);
    if (result.outcome === 'failed') return privateJson({...payload, error: {code: 'failed', message: 'The briefing could not be generated. Nothing was changed.'}}, 500);
    return privateJson(payload);
  } catch (e) {
    logEvent('error', 'api.briefing.regenerate', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'The briefing could not be generated.');
  }
}
