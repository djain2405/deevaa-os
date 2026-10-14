import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const session = vi.hoisted(() => ({user: null as null | {id: string; email: string}}));
vi.mock('@/lib/session', () => ({getSessionUser: vi.fn(async () => session.user)}));

import {authConfig, isAllowedEmail} from '@/auth.config';
import {GET as getBriefing} from '@/app/api/briefing/route';
import {POST as regenerate} from '@/app/api/briefing/regenerate/route';
import {GET as cronGet, POST as cronPost} from '@/app/api/cron/route';
import {POST as chatApply} from '@/app/api/chat/apply/route';
import {DELETE as chatDelete, GET as chatGet, POST as chatPost} from '@/app/api/chat/route';
import {POST as chatUndo} from '@/app/api/chat/undo/route';
import {GET as permissionsGet, POST as permissionsPost} from '@/app/api/permissions/route';
import {GET as callback} from '@/app/api/google/callback/route';
import {POST as connect} from '@/app/api/google/connect/route';
import {POST as disconnect} from '@/app/api/google/disconnect/route';
import {bearerMatches, isSameOrigin} from '@/lib/http';
import {sanitizeFields} from '@/lib/log';
import {isPublicPath} from '@/lib/public-paths';

const BASE = 'http://localhost:3000';
const sameOrigin = {origin: BASE, 'sec-fetch-site': 'same-origin'};

beforeEach(() => {
  session.user = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unauthorized access', () => {
  it('rejects every private API without a session and marks responses private', async () => {
    const responses = await Promise.all([
      getBriefing(new Request(`${BASE}/api/briefing`)),
      regenerate(new Request(`${BASE}/api/briefing/regenerate`, {method: 'POST', headers: {...sameOrigin, 'idempotency-key': 'abcdefgh12'}})),
      connect(new Request(`${BASE}/api/google/connect`, {method: 'POST', headers: sameOrigin})),
      callback(new Request(`${BASE}/api/google/callback?code=x&state=y`)),
      disconnect(new Request(`${BASE}/api/google/disconnect`, {method: 'POST', headers: sameOrigin})),
      chatGet(),
      chatPost(new Request(`${BASE}/api/chat`, {method: 'POST', headers: {...sameOrigin, 'idempotency-key': 'abcdefgh12'}, body: JSON.stringify({message: 'hi'})})),
      chatDelete(new Request(`${BASE}/api/chat`, {method: 'DELETE', headers: sameOrigin})),
      chatApply(new Request(`${BASE}/api/chat/apply`, {method: 'POST', headers: sameOrigin, body: '{}'})),
      chatUndo(new Request(`${BASE}/api/chat/undo`, {method: 'POST', headers: sameOrigin, body: '{}'})),
      permissionsGet(),
      permissionsPost(new Request(`${BASE}/api/permissions`, {method: 'POST', headers: sameOrigin, body: '{}'}))
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = await res.json();
      expect(body.error.code).toBe('unauthorized');
    }
  });

  it('rejects cross-site POSTs before touching the session', async () => {
    session.user = {id: 'u1', email: 'owner@example.com'};
    const res = await regenerate(
      new Request(`${BASE}/api/briefing/regenerate`, {method: 'POST', headers: {origin: 'https://evil.example', 'idempotency-key': 'abcdefgh12'}})
    );
    expect(res.status).toBe(403);
    const res2 = await connect(new Request(`${BASE}/api/google/connect`, {method: 'POST', headers: {'sec-fetch-site': 'cross-site'}}));
    expect(res2.status).toBe(403);
    const evil = {origin: 'https://evil.example', 'idempotency-key': 'abcdefgh12'};
    for (const res of await Promise.all([
      chatPost(new Request(`${BASE}/api/chat`, {method: 'POST', headers: evil, body: JSON.stringify({message: 'I need to buy a boat'})})),
      chatUndo(new Request(`${BASE}/api/chat/undo`, {method: 'POST', headers: evil, body: '{}'})),
      chatApply(new Request(`${BASE}/api/chat/apply`, {method: 'POST', headers: evil, body: '{}'})),
      chatDelete(new Request(`${BASE}/api/chat`, {method: 'DELETE', headers: evil})),
      permissionsPost(new Request(`${BASE}/api/permissions`, {method: 'POST', headers: evil, body: JSON.stringify({permission: 'notion_task_write', status: 'granted'})}))
    ])) {
      expect(res.status).toBe(403);
    }
  });

  it('requires an Origin or Sec-Fetch-Site header on state-changing requests', () => {
    expect(isSameOrigin(new Request(`${BASE}/x`, {method: 'POST'}))).toBe(false);
    expect(isSameOrigin(new Request(`${BASE}/x`, {method: 'POST', headers: {origin: BASE}}))).toBe(true);
    expect(isSameOrigin(new Request(`${BASE}/x`, {method: 'POST', headers: {'sec-fetch-site': 'same-site'}}))).toBe(false);
  });

  it('gates every page and API path except login, auth callbacks and the scheduler', () => {
    for (const p of ['/', '/api/briefing', '/api/briefing/regenerate', '/api/google/connect', '/api/google/callback', '/api/cronjob', '/login/extra', '/api/chat', '/api/permissions', '/api/chat/undo']) {
      expect(isPublicPath(p)).toBe(false);
    }
    for (const p of ['/login', '/api/auth/signin', '/api/auth/callback/google', '/api/cron', '/api/intake']) expect(isPublicPath(p)).toBe(true);
  });
});

describe('scheduler identity', () => {
  it('rejects missing, wrong and unset secrets', async () => {
    vi.stubEnv('CRON_SECRET', 'a-very-long-cron-secret-value-123');
    expect((await cronGet(new Request(`${BASE}/api/cron`))).status).toBe(401);
    expect((await cronPost(new Request(`${BASE}/api/cron`, {method: 'POST', headers: {authorization: 'Bearer wrong-secret-value-000000'}}))).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await cronGet(new Request(`${BASE}/api/cron`, {headers: {authorization: 'Bearer '}}))).status).toBe(401);
  });

  it('refuses short secrets even when they match', () => {
    const req = new Request(`${BASE}/api/cron`, {headers: {authorization: 'Bearer short'}});
    expect(bearerMatches(req, 'short')).toBe(false);
  });
});

describe('app sign-in', () => {
  it('only admits the verified allowed email', () => {
    const signIn = authConfig.callbacks.signIn as (a: {profile?: Record<string, unknown>}) => boolean;
    expect(signIn({profile: {email: 'Owner@Example.com', email_verified: true}})).toBe(true);
    expect(signIn({profile: {email: 'owner@example.com', email_verified: false}})).toBe(false);
    expect(signIn({profile: {email: 'someone@example.com', email_verified: true}})).toBe(false);
  });

  it('denies everyone when ALLOWED_EMAIL is unset', () => {
    vi.stubEnv('ALLOWED_EMAIL', '');
    expect(isAllowedEmail('owner@example.com')).toBe(false);
  });

  it('requests identity scopes only for login', () => {
    const google = authConfig.providers[0] as unknown as {options: {authorization: {params: {scope: string}}}};
    expect(google.options.authorization.params.scope).toBe('openid email profile');
  });
});

describe('server logs', () => {
  it('redacts tokens, codes, emails and event text', () => {
    const out = sanitizeFields({refresh_token: 'r', accessToken: 'a', code: 'c', email: 'e', description: 'd', status: 401, op: 'x', nested: {a: 1}});
    expect(out).toEqual({refresh_token: '[redacted]', accessToken: '[redacted]', code: '[redacted]', email: '[redacted]', description: '[redacted]', status: 401, op: 'x', nested: '[omitted]'});
  });
});
