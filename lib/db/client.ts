import type {PgDatabase, PgQueryResultHKT} from 'drizzle-orm/pg-core';
import * as schema from './schema';
import {MIGRATIONS} from './migrations';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let dbPromise: Promise<Db> | null = null;

export function storeKind(): 'postgres' | 'embedded' {
  return process.env.DATABASE_URL ? 'postgres' : 'embedded';
}

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const {Pool} = await import('pg');
    const {drizzle} = await import('drizzle-orm/node-postgres');
    return drizzle(new Pool({connectionString: url, max: 5}), {schema}) as unknown as Db;
  }
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_EMBEDDED_DB !== 'true') {
    throw new Error('DATABASE_URL is required in production.');
  }
  const {PGlite} = await import('@electric-sql/pglite');
  const {drizzle} = await import('drizzle-orm/pglite');
  const client = new PGlite(process.env.PGLITE_DIR || './.data/pglite');
  for (const sql of MIGRATIONS) await client.exec(sql);
  return drizzle(client, {schema}) as unknown as Db;
}

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = connect().catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

export function setDbForTests(db: Db | null) {
  dbPromise = db ? Promise.resolve(db) : null;
}
