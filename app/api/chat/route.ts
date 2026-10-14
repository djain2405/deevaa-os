import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {processMessage} from '@/lib/intake';
import {countUserMessagesSince, deleteConversation, hasPermission, listMessages, NOTION_WRITE} from '@/lib/intake-store';
import {logEvent} from '@/lib/log';
import {getSessionUser} from '@/lib/session';
import {audit} from '@/lib/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_MESSAGE = 4000;
const HOURLY_LIMIT = 30;

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  try {
    const rows = await listMessages(user.id);
    return privateJson({
      notionWrites: (await hasPermission(user.id, NOTION_WRITE)) ? 'granted' : 'off',
      messages: rows.map((m) => ({id: m.id, role: m.role, content: m.content, createdAt: m.createdAt.toISOString(), result: m.role === 'assistant' ? m.result : null}))
    });
  } catch (e) {
    logEvent('error', 'api.chat.get', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'Could not load the conversation.');
  }
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const key = req.headers.get('idempotency-key') ?? '';
  if (!KEY.test(key)) return apiError(400, 'bad_idempotency_key', 'Send an Idempotency-Key header (8-100 letters, digits, - or _).');
  const body = (await req.json().catch(() => null)) as {message?: unknown} | null;
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) return apiError(400, 'empty_message', 'Write a message first.');
  if (message.length > MAX_MESSAGE) return apiError(413, 'message_too_long', `Keep messages under ${MAX_MESSAGE} characters.`);

  try {
    if ((await countUserMessagesSince(user.id, new Date(Date.now() - 3600 * 1000))) >= HOURLY_LIMIT) {
      return apiError(429, 'rate_limited', 'That is a lot of messages for one hour. Try again a little later.');
    }
    const result = await processMessage({userId: user.id, message, clientKey: key});
    return privateJson(result);
  } catch (e) {
    logEvent('error', 'api.chat.post', {kind: e instanceof Error ? e.name : 'unknown'});
    return apiError(500, 'internal', 'The message could not be processed. Nothing was written to Notion.');
  }
}

/** Deletes chat history and unreviewed notes. Notion tasks and the audit trail are kept. */
export async function DELETE(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  await deleteConversation(user.id);
  await audit(user.id, 'chat.delete', 'ok');
  return privateJson({deleted: true});
}
