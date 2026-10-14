import {apiError} from './http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads `{messageId}` from a JSON body; returns an error response when it is missing or malformed. */
export async function readMessageId(req: Request): Promise<{id: string} | {error: Response}> {
  const body = (await req.json().catch(() => null)) as {messageId?: unknown} | null;
  const id = typeof body?.messageId === 'string' ? body.messageId : '';
  return UUID.test(id) ? {id} : {error: apiError(400, 'bad_message_id', 'Send the id of a chat message.')};
}
