import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

const storage = new AsyncLocalStorage<{id: string}>();

export function bindCorrelation(id: string) {
  storage.enterWith({id});
  return id;
}

export function currentCorrelation() {
  return storage.getStore()?.id ?? null;
}

export function bindRequest(req: Request) {
  const incoming = req.headers.get('x-correlation-id');
  const id = incoming && /^[A-Za-z0-9_.:-]{8,80}$/.test(incoming) ? incoming : randomUUID();
  return bindCorrelation(id);
}

/** Reads the middleware header when a route forgot to bind one. Safe outside a request. */
export async function correlationFromRequest(): Promise<string | null> {
  const current = currentCorrelation();
  if (current) return current;
  try {
    const {headers} = await import('next/headers');
    const id = (await headers()).get('x-correlation-id');
    if (id) return bindCorrelation(id);
  } catch {
    return null;
  }
  return null;
}
