import {integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  blueprintNotionPageId: text('blueprint_notion_page_id'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow()
});

/** Holds encrypted token material only; plaintext never leaves the Google OAuth modules. */
export const oauthCredentials = pgTable(
  'oauth_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
    provider: text('provider').notNull(),
    encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    scope: text('scope').notNull(),
    calendarIds: jsonb('calendar_ids').$type<string[]>().notNull().default([]),
    status: text('status').$type<'active' | 'revoked'>().notNull().default('active'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow()
  },
  (t) => [uniqueIndex('oauth_credentials_user_provider').on(t.userId, t.provider)]
);

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
  localDate: text('local_date').notNull(),
  trigger: text('trigger').$type<'cron' | 'manual' | 'initial' | 'intake' | 'agent'>().notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  status: text('status').$type<'running' | 'succeeded' | 'failed'>().notNull(),
  attempts: integer('attempts').notNull().default(1),
  errorCode: text('error_code'),
  briefingId: uuid('briefing_id'),
  startedAt: timestamp('started_at', {withTimezone: true}).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', {withTimezone: true})
});

export const briefings = pgTable(
  'briefings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
    localDate: text('local_date').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    runId: uuid('run_id'),
    generatedAt: timestamp('generated_at', {withTimezone: true}).notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow()
  },
  (t) => [uniqueIndex('briefings_user_date_version').on(t.userId, t.localDate, t.version)]
);

export const locks = pgTable('locks', {
  key: text('key').primaryKey(),
  owner: text('owner').notNull(),
  expiresAt: timestamp('expires_at', {withTimezone: true}).notNull()
});

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, {onDelete: 'set null'}),
  action: text('action').notNull(),
  result: text('result').notNull(),
  detail: jsonb('detail').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow()
});

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow()
  },
  (t) => [uniqueIndex('conversations_user').on(t.userId)]
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id, {onDelete: 'cascade'}),
    userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: text('content').notNull(),
    clientKey: text('client_key'),
    result: jsonb('result'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow()
  },
  (t) => [uniqueIndex('messages_user_client_key').on(t.userId, t.clientKey)]
);

export type OpStatus = 'proposed' | 'pending' | 'succeeded' | 'failed' | 'undone';

export const intakeOps = pgTable('intake_ops', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
  messageId: uuid('message_id').references(() => messages.id, {onDelete: 'set null'}),
  opKey: text('op_key').notNull().unique(),
  kind: text('kind').$type<'create' | 'update'>().notNull(),
  status: text('status').$type<OpStatus>().notNull(),
  pageId: text('page_id'),
  pageUrl: text('page_url'),
  title: text('title').notNull(),
  fields: jsonb('fields').$type<Record<string, unknown>>().notNull().default({}),
  before: jsonb('before').$type<Record<string, unknown> | null>(),
  afterEditedAt: text('after_edited_at'),
  errorCode: text('error_code'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow()
});

export const permissions = pgTable(
  'permissions',
  {
    userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
    permission: text('permission').notNull(),
    status: text('status').$type<'granted' | 'revoked'>().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow()
  },
  (t) => [primaryKey({columns: [t.userId, t.permission]})]
);

export const blueprintVersions = pgTable(
  'blueprint_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
    version: integer('version').notNull(),
    data: jsonb('data').notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow()
  },
  (t) => [uniqueIndex('blueprint_versions_user_version').on(t.userId, t.version)]
);

export const blueprintSuggestions = pgTable('blueprint_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
  kind: text('kind').notNull(),
  text: text('text').notNull(),
  messageId: uuid('message_id').references(() => messages.id, {onDelete: 'cascade'}),
  status: text('status').$type<'pending' | 'confirmed' | 'dismissed'>().notNull().default('pending'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow()
});

export const blueprintImports = pgTable(
  'blueprint_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
    sourceName: text('source_name').notNull(),
    contentSha256: text('content_sha256').notNull(),
    previewSha256: text('preview_sha256').notNull(),
    preview: jsonb('preview').notNull(),
    status: text('status').$type<'preview' | 'applied' | 'canceled'>().notNull().default('preview'),
    applyReport: jsonb('apply_report').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', {withTimezone: true})
  },
  (t) => [uniqueIndex('blueprint_imports_user_content').on(t.userId, t.contentSha256)]
);

export const emailItems = pgTable(
  'email_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
    permalink: text('permalink').notNull(),
    kind: text('kind').$type<'hidden' | 'saved'>().notNull(),
    title: text('title'),
    pageId: text('page_id'),
    pageUrl: text('page_url'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow()
  },
  (t) => [uniqueIndex('email_items_user_permalink').on(t.userId, t.permalink)]
);

export const actionFeedback = pgTable('action_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
  taskId: text('task_id').notNull(),
  kind: text('kind').$type<'done' | 'not_now' | 'not_possible_here' | 'wrong'>().notNull(),
  minutes: integer('minutes'),
  energy: text('energy'),
  context: text('context'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow()
});
