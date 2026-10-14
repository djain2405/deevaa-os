import {createHmac} from 'node:crypto';
import {apiError, bearerMatches, privateJson, safeEqual} from '@/lib/http';
import {processMessage} from '@/lib/intake';
import {countUserMessagesSince} from '@/lib/intake-store';
import {logEvent} from '@/lib/log';
import {audit, getOrCreateUser} from '@/lib/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_MESSAGE = 4000;
const MAX_BODY = 16_000;
const HOURLY_LIMIT = 30;
const MAX_SKEW_SECONDS = 300;

/**
 * Signed intake for tools the owner controls (a Shortcut, a ChatGPT action, a script).
 * Headers: Authorization: Bearer $INTAKE_TOKEN, Idempotency-Key, X-Deevaa-Timestamp (unix seconds),
 * X-Deevaa-Signature: hex HMAC-SHA256 of `${timestamp}.${idempotencyKey}.${rawBody}` keyed with $INTAKE_TOKEN.
 * Writes still require the standing Notion permission granted in the app.
 */
export async function POST(req: Request) {
  const secret = process.env.INTAKE_TOKEN;
  if (!secret || secret.length < 32) return apiError(404, 'not_found', 'Not found.');
  if (!bearerMatches(req, secret)) return apiError(401, 'unauthorized', 'Invalid intake credentials.');

  const key = req.headers.get('idempotency-key') ?? '';
  if (!KEY.test(key)) return apiError(400, 'bad_idempotency_key', 'Send an Idempotency-Key header (8-100 letters, digits, - or _).');
  const timestamp = req.headers.get('x-deevaa-timestamp') ?? '';
  const ts = /^\d{9,11}$/.test(timestamp) ? Number(timestamp) : NaN;
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) {
    return apiError(401, 'stale_request', 'X-Deevaa-Timestamp is missing or more than 5 minutes off.');
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) return apiError(413, 'body_too_large', 'Request body is too large.');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${key}.${raw}`).digest('hex');
  if (!safeEqual((req.headers.get('x-deevaa-signature') ?? '').toLowerCase(), expected)) {
    return apiError(401, 'bad_signature', 'Signature did not match.');
  }

  let body: {message?: unknown} | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return apiError(400, 'bad_json', 'Body must be JSON like {"message": "..."}.');
  }
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) return apiError(400, 'empty_message', 'Send a non-empty "message".');
  if (message.length > MAX_MESSAGE) return apiError(413, 'message_too_long', `Keep messages under ${MAX_MESSAGE} characters.`);

  const email = process.env.ALLOWED_EMAIL;
  if (!email) return apiError(500, 'not_configured', 'Intake is not configured.');
  try {
    const user = await getOrCreateUser(email);
    if ((await countUserMessagesSince(user.id, new Date(Date.now() - 3600 * 1000))) >= HOURLY_LIMIT) {
      return apiError(429, 'rate_limited', 'Too many messages this hour. Try again later.');
    }
    const result = await processMessage({userId: user.id, message, clientKey: `ext-${key}`});
    await audit(user.id, 'intake.external', 'ok', {writes: result.writes, items: result.items.length});
    return privateJson({messageId: result.messageId, writes: result.writes, items: result.items, clarifications: result.clarifications, reply: result.reply});
  } catch (e) {
    logEvent('error', 'api.intake', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'The message could not be processed. Nothing was written to Notion.');
  }
}
