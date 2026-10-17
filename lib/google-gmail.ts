import {decryptSecret, encryptSecret} from './crypto';
import {logEvent} from './log';
import {providerFetch, type FetchOptions} from './provider-fetch';
import {getCredential, markCredentialRevoked, saveCredential} from './store';
import type {SourceHealth} from './types';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_PROVIDER = 'google_gmail';
export const GMAIL_STATE_COOKIE = 'deevaa_gmail_nonce';
export const GMAIL_QUERY = 'in:inbox newer_than:24h -category:promotions -category:social';
export const MAX_MESSAGES = 40;
export const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const SKIP_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']);

export class GmailError extends Error {
  constructor(public kind: 'revoked' | 'unavailable' | 'config' | 'scope' | 'no_refresh_token', message: string) {
    super(message);
  }
}

const aad = (userId: string) => `${userId}:${GMAIL_PROVIDER}`;

function clientConfig() {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret || !process.env.APP_URL) throw new GmailError('config', 'Google OAuth is not configured.');
  return {clientId, clientSecret, redirectUri: new URL('/api/google/gmail/callback', process.env.APP_URL).toString()};
}

export function buildGmailAuthUrl(state: string, loginHint?: string) {
  const {clientId, redirectUri} = clientConfig();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    ...(loginHint ? {login_hint: loginHint} : {})
  }).toString();
  return url.toString();
}

const GMAIL_WRITE = /gmail\.(modify|send|compose|insert|metadata|labels)|mail\.google\.com/i;

/** Rejects grants that are missing readonly or that include any Gmail write/send scope. */
export function scopeIsGmailReadOnly(scope: string) {
  const scopes = scope.split(/\s+/).filter(Boolean);
  if (!scopes.includes(GMAIL_SCOPE)) return false;
  return scopes.every((s) => s === GMAIL_SCOPE || (!s.includes('gmail') && !GMAIL_WRITE.test(s)));
}

async function tokenRequest(op: string, params: Record<string, string>, opts: FetchOptions) {
  const res = await providerFetch(
    op,
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams(params)
    },
    opts
  ).catch(() => {
    throw new GmailError('unavailable', 'Could not reach Google.');
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body?.error === 'invalid_grant' || res.status === 401) {
      throw new GmailError('revoked', 'Gmail access was revoked or expired. Reconnect Gmail.');
    }
    throw new GmailError('unavailable', 'Google rejected the token request.');
  }
  return body as {access_token: string; refresh_token?: string; scope?: string};
}

export async function completeGmailAuthorization(userId: string, code: string, opts: FetchOptions = {}) {
  const {clientId, clientSecret, redirectUri} = clientConfig();
  const token = await tokenRequest(
    'gmail.token.exchange',
    {code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code'},
    opts
  );
  if (!token.scope || !scopeIsGmailReadOnly(token.scope)) {
    throw new GmailError('scope', 'Google granted unexpected permissions; only read-only Gmail access is accepted.');
  }
  if (!token.refresh_token) {
    throw new GmailError('no_refresh_token', 'Google did not return offline access. Remove Deevaa from your Google account permissions and connect again.');
  }
  await saveCredential({
    userId,
    provider: GMAIL_PROVIDER,
    encryptedRefreshToken: encryptSecret(token.refresh_token, aad(userId)),
    scope: GMAIL_SCOPE,
    calendarIds: []
  });
}

export async function revokeGmailAndForget(userId: string, opts: FetchOptions = {}) {
  const cred = await getCredential(userId, GMAIL_PROVIDER);
  if (!cred) return;
  try {
    const refresh = decryptSecret(cred.encryptedRefreshToken, aad(userId));
    await providerFetch(
      'gmail.revoke',
      'https://oauth2.googleapis.com/revoke',
      {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({token: refresh})
      },
      {...opts, retries: 0}
    );
  } catch {
    logEvent('warn', 'gmail.revoke', {status: 'failed'});
  }
}

export type GmailMessage = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  excerpt: string;
  labelIds: string[];
  internalDate: number | null;
};

function header(headers: {name?: string; value?: string}[] | undefined, name: string) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBody(data: string | undefined) {
  if (!data) return '';
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

type Payload = {mimeType?: string; body?: {data?: string}; parts?: Payload[]; headers?: {name?: string; value?: string}[]};

function textPlain(payload: Payload | undefined, max = 1500): string {
  if (!payload) return '';
  if ((payload.mimeType === 'text/plain' || !payload.mimeType) && payload.body?.data) {
    return decodeBody(payload.body.data).slice(0, max);
  }
  for (const part of payload.parts ?? []) {
    const text = textPlain(part, max);
    if (text) return text;
  }
  return '';
}

export function gmailPermalink(threadId: string) {
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}`;
}

export function isSkippedCategory(labelIds: string[] | undefined) {
  return (labelIds ?? []).some((id) => SKIP_LABELS.has(id));
}

function parseMessage(raw: {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string | number;
  payload?: Payload;
}): GmailMessage | null {
  if (!raw.id || !raw.threadId) return null;
  if (isSkippedCategory(raw.labelIds)) return null;
  const headers = raw.payload?.headers;
  const snippet = (raw.snippet ?? '').slice(0, 300);
  const excerpt = snippet ? '' : textPlain(raw.payload);
  const internalDate = raw.internalDate != null ? Number(raw.internalDate) : null;
  return {
    id: raw.id,
    threadId: raw.threadId,
    subject: header(headers, 'Subject').slice(0, 200),
    from: header(headers, 'From').slice(0, 200),
    snippet,
    excerpt: excerpt.slice(0, 1500),
    labelIds: raw.labelIds ?? [],
    internalDate: Number.isFinite(internalDate) ? internalDate : null
  };
}

async function listIds(accessToken: string, opts: FetchOptions) {
  const q = new URLSearchParams({q: GMAIL_QUERY, maxResults: String(MAX_MESSAGES)});
  const res = await providerFetch(
    'gmail.messages.list',
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`,
    {headers: {Authorization: `Bearer ${accessToken}`}},
    opts
  );
  if (res.status === 401) throw new GmailError('revoked', 'Gmail access was revoked or expired. Reconnect Gmail.');
  if (!res.ok) throw new GmailError('unavailable', 'Gmail could not be read.');
  const body = await res.json();
  return ((body.messages ?? []) as {id: string; threadId?: string}[]).slice(0, MAX_MESSAGES);
}

async function getMessage(accessToken: string, id: string, opts: FetchOptions) {
  const q = new URLSearchParams({
    format: 'full',
    fields: 'id,threadId,labelIds,snippet,internalDate,payload/mimeType,payload/headers,payload/body/data,payload/parts'
  });
  const res = await providerFetch(
    'gmail.messages.get',
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${q}`,
    {headers: {Authorization: `Bearer ${accessToken}`}},
    opts
  );
  if (res.status === 401) throw new GmailError('revoked', 'Gmail access was revoked or expired. Reconnect Gmail.');
  if (!res.ok) throw new GmailError('unavailable', 'Gmail could not be read.');
  return res.json();
}

export async function fetchGmailMessages(
  userId: string,
  opts: FetchOptions = {}
): Promise<{messages: GmailMessage[]; health: SourceHealth}> {
  const cred = await getCredential(userId, GMAIL_PROVIDER);
  if (!cred) {
    return {
      messages: [],
      health: {
        state: 'not_connected',
        message: 'Gmail is not connected. Connect Gmail (read-only) in Connections to include this morning’s mail.',
        lastSyncedAt: null,
        count: 0,
        warnings: []
      }
    };
  }
  if (cred.status === 'revoked') {
    return {
      messages: [],
      health: {
        state: 'error',
        message: 'Gmail access was revoked. Reconnect Gmail.',
        lastSyncedAt: null,
        count: 0,
        warnings: []
      }
    };
  }
  try {
    const {clientId, clientSecret} = clientConfig();
    const refresh = decryptSecret(cred.encryptedRefreshToken, aad(userId));
    const {access_token} = await tokenRequest(
      'gmail.token.refresh',
      {client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: 'refresh_token'},
      opts
    );
    const ids = await listIds(access_token, opts);
    const warnings: string[] = [];
    const messages: GmailMessage[] = [];
    let failed = 0;
    for (const row of ids) {
      try {
        const parsed = parseMessage(await getMessage(access_token, row.id, opts));
        if (parsed && (parsed.internalDate == null || parsed.internalDate >= Date.now() - SCAN_WINDOW_MS)) messages.push(parsed);
      } catch (e) {
        if (e instanceof GmailError && e.kind === 'revoked') throw e;
        failed++;
      }
    }
    if (ids.length && failed === ids.length) throw new GmailError('unavailable', 'Gmail could not be read.');
    if (failed) warnings.push('Some messages could not be read; the digest may be incomplete.');
    if (ids.length === MAX_MESSAGES) warnings.push('Stopped after the 40 most recent messages from the last 24 hours.');
    return {
      messages,
      health: {
        state: 'connected',
        message: `Read ${messages.length} inbox message(s) from the last day.`,
        lastSyncedAt: new Date().toISOString(),
        count: messages.length,
        warnings
      }
    };
  } catch (e) {
    const err = e instanceof GmailError ? e : new GmailError('unavailable', 'Gmail could not be read.');
    if (err.kind === 'revoked') await markCredentialRevoked(userId, GMAIL_PROVIDER);
    logEvent('error', 'gmail.fetch', {kind: err.kind});
    const message =
      err.kind === 'revoked'
        ? err.message
        : err.kind === 'config'
          ? 'Google OAuth is not configured on the server.'
          : 'Gmail could not be read right now.';
    return {messages: [], health: {state: 'error', message, lastSyncedAt: null, count: 0, warnings: []}};
  }
}
