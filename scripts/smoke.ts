import {PGlite} from '@electric-sql/pglite';
import {MIGRATIONS} from '../lib/db/migrations';
import {validateEnv} from '../lib/env';
import {healthPayload} from '../lib/health';
import {apiError} from '../lib/http';
import {isPublicPath} from '../lib/public-paths';

async function main() {
  const env = validateEnv(process.env, {production: false});
  if (!env.ok) throw new Error(`env ${env.invalid.join(',')}`);
  const client = new PGlite();
  for (const sql of MIGRATIONS) await client.exec(sql);
  const tables = await client.query<{table_name: string}>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name = 'user_settings'"
  );
  if (!tables.rows.length) throw new Error('user_settings missing after migrate');
  if (!isPublicPath('/api/health')) throw new Error('health route is not public');
  if (isPublicPath('/api/settings')) throw new Error('settings must require a session');
  const health = healthPayload('embedded');
  if (!health.ok || health.service !== 'deevaa-os') throw new Error('health payload');
  const denied = apiError(401, 'unauthorized', 'Sign in to continue.');
  if (denied.status !== 401) throw new Error('auth rejection');
  console.log('Smoke passed: migrations, health, and auth rejection shape.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'smoke failed');
  process.exit(1);
});
