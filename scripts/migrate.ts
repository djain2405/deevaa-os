import {loadEnvConfig} from '@next/env';
import {Client} from 'pg';
import {MIGRATIONS} from '../lib/db/migrations';

loadEnvConfig(process.cwd());

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('DATABASE_URL is not set. Local dev uses the embedded store in ./.data/pglite, which migrates itself on start.');
    return;
  }
  const client = new Client({connectionString: url});
  await client.connect();
  try {
    for (const sql of MIGRATIONS) await client.query(sql);
    console.log(`Migrations 0001-${String(MIGRATIONS.length).padStart(4, '0')} applied (idempotent).`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`Migration failed: ${e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/g, '[database url]') : 'unknown error'}`);
  process.exit(1);
});
