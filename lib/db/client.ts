import path from 'node:path';
import type {PgDatabase, PgQueryResultHKT} from 'drizzle-orm/pg-core';
import {assertProductionEnv} from '../env';
import * as schema from './schema';
import {MIGRATIONS} from './migrations';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const globalDb = globalThis as typeof globalThis & {__deevaaDbPromise?: Promise<Db> | null};

function embeddedDir() {
  if (process.env.PGLITE_DIR) return process.env.PGLITE_DIR;
  return path.join(process.cwd(), '.data', 'pglite');
}

async function migratePostgres(url: string) {
  const {Client} = await import('pg');
  const client = new Client({connectionString: url});
  await client.connect();
  try {
    for (const sql of MIGRATIONS) await client.query(sql);
  } finally {
    await client.end();
  }
}

async function connect(): Promise<Db> {
  assertProductionEnv();
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    await migratePostgres(url);
    const {Pool} = await import('pg');
    const {drizzle} = await import('drizzle-orm/node-postgres');
    return drizzle(new Pool({connectionString: url, max: 5}), {schema}) as unknown as Db;
  }
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_EMBEDDED_DB !== 'true') {
    throw new Error('DATABASE_URL is required in production.');
  }
  const {PGlite} = await import('@electric-sql/pglite');
  const {drizzle} = await import('drizzle-orm/pglite');
  const client = new PGlite(embeddedDir());
  for (const sql of MIGRATIONS) await client.exec(sql);
  return drizzle(client, {schema}) as unknown as Db;
}

export function storeKind(): 'postgres' | 'embedded' {
  return process.env.DATABASE_URL?.trim() ? 'postgres' : 'embedded';
}

export function getDb(): Promise<Db> {
  if (!globalDb.__deevaaDbPromise) {
    globalDb.__deevaaDbPromise = connect().catch((e) => {
      globalDb.__deevaaDbPromise = null;
      throw e;
    });
  }
  return globalDb.__deevaaDbPromise;
}

export function setDbForTests(db: Db | null) {
  globalDb.__deevaaDbPromise = db ? Promise.resolve(db) : null;
}
