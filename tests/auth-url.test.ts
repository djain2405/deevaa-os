import {afterEach, describe, expect, it} from 'vitest';
import {appOrigin, authOrigin, isLoopbackOrigin} from '@/lib/auth-url';
import {syncAuthEnv} from '@/lib/sync-auth-env';

afterEach(() => {
  delete process.env.AUTH_URL;
  delete process.env.NEXTAUTH_URL;
  delete process.env.APP_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
});

describe('authOrigin', () => {
  it('prefers a public APP_URL over an internal AUTH_URL host', () => {
    expect(
      authOrigin({
        AUTH_URL: 'https://localhost:8080',
        APP_URL: 'https://deevaa-os-production.up.railway.app'
      })
    ).toBe('https://deevaa-os-production.up.railway.app');
  });

  it('uses Railway public domain when APP_URL is missing', () => {
    expect(authOrigin({RAILWAY_PUBLIC_DOMAIN: 'deevaa-os-production.up.railway.app'})).toBe(
      'https://deevaa-os-production.up.railway.app'
    );
  });

  it('keeps localhost for local development', () => {
    expect(authOrigin({APP_URL: 'http://localhost:3000'})).toBe('http://localhost:3000');
  });
});

describe('appOrigin', () => {
  it('does not send OAuth redirects to Railway internal localhost:8080', () => {
    const req = new Request('https://localhost:8080/api/google/gmail/callback?gmail=connected');
    expect(
      appOrigin(req, {
        AUTH_URL: 'https://localhost:8080',
        APP_URL: 'https://deevaa-os-production.up.railway.app'
      })
    ).toBe('https://deevaa-os-production.up.railway.app');
  });
});

describe('syncAuthEnv', () => {
  it('writes AUTH_URL from APP_URL when Auth.js has no URL', () => {
    const env: NodeJS.Dict<string> = {APP_URL: 'https://deevaa-os-production.up.railway.app'};
    expect(syncAuthEnv(env)).toBe('https://deevaa-os-production.up.railway.app');
    expect(env.AUTH_URL).toBe('https://deevaa-os-production.up.railway.app');
  });

  it('replaces loopback AUTH_URL with the public origin', () => {
    const env: NodeJS.Dict<string> = {
      AUTH_URL: 'https://localhost:8080',
      APP_URL: 'https://deevaa-os-production.up.railway.app'
    };
    syncAuthEnv(env);
    expect(env.AUTH_URL).toBe('https://deevaa-os-production.up.railway.app');
  });

  it('does not override a public AUTH_URL', () => {
    const env: NodeJS.Dict<string> = {
      AUTH_URL: 'https://app.example.com',
      APP_URL: 'https://other.example.com'
    };
    syncAuthEnv(env);
    expect(env.AUTH_URL).toBe('https://app.example.com');
  });
});

describe('isLoopbackOrigin', () => {
  it('detects Railway internal hosts', () => {
    expect(isLoopbackOrigin('https://localhost:8080')).toBe(true);
    expect(isLoopbackOrigin('https://deevaa-os-production.up.railway.app')).toBe(false);
  });
});
