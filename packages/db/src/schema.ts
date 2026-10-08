import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// 时间字段（*_at）均为毫秒时间戳。见 PLAN.md 5.2。

/** 管理令牌哈希、自动生成的密钥等实例级配置 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['remote', 'local'] }).notNull(),
  /** 远程订阅 URL 的密文（AES-GCM），本地订阅为 null */
  urlEnc: text('url_enc'),
  /** 本地订阅的内容，远程订阅为 null */
  content: text('content'),
  userAgent: text('user_agent'),
  ttlSec: integer('ttl_sec').notNull(),
  /** 最近一次尝试拉取的时间（无论成败） */
  lastFetchedAt: integer('last_fetched_at'),
  lastStatus: text('last_status', { enum: ['ok', 'error'] }),
  lastError: text('last_error'),
  userinfoJson: text('userinfo_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  irJson: text('ir_json').notNull(),
  pipelineJson: text('pipeline_json').notNull(),
  sourceIdsJson: text('source_ids_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const outputs = sqliteTable(
  'outputs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    target: text('target', { enum: ['mihomo', 'surge', 'shadowrocket', 'loon', 'auto'] }).notNull(),
    token: text('token').notNull().unique(),
    optionsJson: text('options_json').notNull(),
    lastAccessAt: integer('last_access_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('outputs_profile_id_idx').on(t.profileId)],
)

export const fetchLogs = sqliteTable(
  'fetch_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    at: integer('at').notNull(),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    bytes: integer('bytes'),
    durationMs: integer('duration_ms'),
    error: text('error'),
  },
  (t) => [index('fetch_logs_source_id_idx').on(t.sourceId, t.id)],
)
