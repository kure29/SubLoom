import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type * as schema from './schema.js'

/** better-sqlite3（同步）或 D1（异步）的 Drizzle 实例。server 中一律 await 查询结果。 */
export type SubloomDb = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof schema>
