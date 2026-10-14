import {recordFeedback} from '@/lib/feedback';
import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {countFeedbackSince} from '@/lib/intake-store';
import {logEvent} from '@/lib/log';
import {ACTION_WINDOWS, CONTEXTS, ENERGY_LEVELS, FEEDBACK_KINDS, type FeedbackKind} from '@/lib/next-action';
import {getSessionUser} from '@/lib/session';

export const dynamic = 'force-dynamic';

const TASK_ID = /^[0-9a-f-]{32,36}$|^[A-Za-z0-9_-]{1,64}$/i;
const DAILY_LIMIT = 200;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
  const kind = body?.kind as FeedbackKind;
  if (!TASK_ID.test(taskId)) return apiError(400, 'bad_task', 'Send a task id.');
  if (!FEEDBACK_KINDS.includes(kind)) return apiError(400, 'bad_kind', 'Unknown feedback.');
  const minutes = ACTION_WINDOWS.includes(body?.minutes as 5) ? (body!.minutes as number) : null;
  const energy = ENERGY_LEVELS.includes(body?.energy as 'Low') ? (body!.energy as string) : null;
  const context = CONTEXTS.includes(body?.context as 'Home') ? (body!.context as string) : null;
  try {
    if ((await countFeedbackSince(user.id, new Date(Date.now() - 24 * 3600 * 1000))) >= DAILY_LIMIT) {
      return apiError(429, 'rate_limited', 'Too much feedback today. Try again tomorrow.');
    }
    return privateJson(await recordFeedback(user.id, {taskId, kind, minutes, energy, context}));
  } catch (e) {
    logEvent('error', 'api.feedback', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'Feedback could not be saved.');
  }
}
