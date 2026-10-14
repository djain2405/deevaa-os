import {logEvent} from './log';

export type FetchOptions = {fetchImpl?: typeof fetch; retries?: number; retryDelayMs?: number; timeoutMs?: number};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries only transient failures (network, 429, 5xx). Provider response bodies are never logged. */
export async function providerFetch(op: string, url: string, init: RequestInit, opts: FetchOptions = {}) {
  const {fetchImpl = fetch, retries = 2, retryDelayMs = 300, timeoutMs = 15000} = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {...init, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs)});
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        logEvent('warn', op, {status: res.status, attempt});
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : retryDelayMs * 2 ** attempt);
        continue;
      }
      if (!res.ok) logEvent('warn', op, {status: res.status, attempt});
      return res;
    } catch (e) {
      lastError = e;
      logEvent('warn', op, {status: 'network', attempt});
      if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Network failure');
}
