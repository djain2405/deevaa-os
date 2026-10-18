import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {processImportedNote} from '@/lib/intake';
import {getSessionUser} from '@/lib/session';

export const dynamic = 'force-dynamic';

const KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** Voice transcripts and pasted notes use the same intake pipeline as chat. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const key = req.headers.get('idempotency-key') ?? '';
  if (!KEY.test(key)) return apiError(400, 'bad_idempotency_key', 'Send an Idempotency-Key header.');
  const body = (await req.json().catch(() => null)) as {text?: unknown; source?: unknown} | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return apiError(400, 'empty_message', 'Paste a note first.');
  if (text.length > 4000) return apiError(413, 'message_too_long', 'Keep notes under 4000 characters.');
  const source = body?.source === 'voice' || body?.source === 'import' ? body.source : 'import';
  const result = await processImportedNote({userId: user.id, message: text, clientKey: key, source});
  return privateJson(result);
}
