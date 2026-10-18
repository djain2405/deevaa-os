import {z} from 'zod';

/** Present in every deployed environment. Local dev may omit them and use the embedded store. */
export const PRODUCTION_ENV = ['DATABASE_URL', 'AUTH_SECRET', 'AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET', 'ALLOWED_EMAIL', 'CRON_SECRET', 'TOKEN_ENCRYPTION_KEY', 'APP_URL'] as const;

export const OPTIONAL_ENV = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'INTAKE_TOKEN', 'NOTION_TOKEN', 'NOTION_DATA_SOURCE_ID', 'NOTION_DATABASE_ID', 'NOTION_PARENT_PAGE_ID', 'PGLITE_DIR', 'ALLOW_EMBEDDED_DB'] as const;

const shape = z.object({
  NODE_ENV: z.string().optional(),
  NEXT_PHASE: z.string().optional(),
  DATABASE_URL: z.string().min(1).optional(),
  AUTH_SECRET: z.string().min(32).optional(),
  TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(16).optional(),
  ALLOWED_EMAIL: z.string().email().optional(),
  APP_URL: z.string().url().optional()
});

export type EnvReport = {ok: boolean; missing: string[]; invalid: string[]};

export function validateEnv(env: NodeJS.Dict<string> = process.env, opts: {production?: boolean} = {}): EnvReport {
  const production = opts.production ?? env.NODE_ENV === 'production';
  const missing: string[] = [];
  const invalid: string[] = [];
  if (production && env.NEXT_PHASE !== 'phase-production-build') {
    for (const key of PRODUCTION_ENV) {
      if (!env[key]?.trim()) missing.push(key);
    }
  }
  const parsed = shape.safeParse({
    NODE_ENV: env.NODE_ENV,
    NEXT_PHASE: env.NEXT_PHASE,
    DATABASE_URL: env.DATABASE_URL || undefined,
    AUTH_SECRET: env.AUTH_SECRET || undefined,
    TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY || undefined,
    CRON_SECRET: env.CRON_SECRET || undefined,
    ALLOWED_EMAIL: env.ALLOWED_EMAIL || undefined,
    APP_URL: env.APP_URL || undefined
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) invalid.push(String(issue.path[0] ?? 'env'));
  }
  return {ok: missing.length === 0 && invalid.length === 0, missing, invalid};
}

/** Refuses to boot a production server with a partial secret set. Skipped during `next build`. */
export function assertProductionEnv(env: NodeJS.Dict<string> = process.env) {
  const report = validateEnv(env, {production: env.NODE_ENV === 'production'});
  if (!report.ok && env.NODE_ENV === 'production' && env.NEXT_PHASE !== 'phase-production-build') {
    throw new Error(`Missing or invalid production environment: ${[...report.missing, ...report.invalid].join(', ')}`);
  }
}
