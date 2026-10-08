import { sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { SubloomDb } from './db.js'
import { migrations as bundled } from './migrations.gen.js'

export interface Migration {
  /** drizzle-kit 的迁移名，如 0000_init */
  tag: string
  /** 迁移文件原文，语句之间以 `--> statement-breakpoint` 分隔 */
  sql: string
}

const TABLE = '__subloom_migrations'

/** 按 drizzle-kit 的分隔符拆分迁移语句 */
export function splitStatements(text: string): string[] {
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * 执行尚未执行的迁移，返回本次执行的迁移名。幂等，可在每次启动时调用。
 * 每个迁移连同记录在一个事务中执行。
 */
export async function migrate(
  db: SubloomDb,
  migrations: readonly Migration[] = bundled,
): Promise<string[]> {
  await db.run(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS \`${TABLE}\` (\`tag\` text PRIMARY KEY NOT NULL, \`applied_at\` integer NOT NULL)`,
    ),
  )
  const rows = await db.all<{ tag: string }>(sql.raw(`SELECT \`tag\` FROM \`${TABLE}\``))
  const applied = new Set(rows.map((r) => r.tag))
  const pending = migrations.filter((m) => !applied.has(m.tag))
  if (pending.length === 0) return []

  if ('batch' in db) return migrateBatch(db as unknown as BatchDb, pending)

  const syncDb = db as unknown as BaseSQLiteDatabase<'sync', unknown>
  const done: string[] = []
  for (const m of pending) {
    syncDb.transaction((tx) => {
      // 并发初始化时（多个请求同时触发）可能已被其他调用执行，在事务内再确认一次
      const exists = tx.all(sql`SELECT 1 FROM ${sql.identifier(TABLE)} WHERE tag = ${m.tag}`)
      if (exists.length > 0) return
      for (const statement of splitStatements(m.sql)) tx.run(sql.raw(statement))
      tx.run(
        sql`INSERT INTO ${sql.identifier(TABLE)} (tag, applied_at) VALUES (${m.tag}, ${Date.now()})`,
      )
      done.push(m.tag)
    })
  }
  return done
}

/** D1 等异步驱动：db.batch 中的语句在一个事务中执行，任一语句失败整体回滚 */
type BatchItem = ReturnType<SubloomDb['run']>
interface BatchDb {
  run: SubloomDb['run']
  all: SubloomDb['all']
  batch(items: [BatchItem, ...BatchItem[]]): Promise<unknown>
}

/**
 * D1 不支持交互式事务：每个迁移的语句连同迁移记录用 db.batch 一次提交。
 * 多个实例并发执行时，后提交的一方因表已存在或记录重复而失败回滚，确认该迁移已被执行后继续。
 */
async function migrateBatch(db: BatchDb, pending: readonly Migration[]): Promise<string[]> {
  const done: string[] = []
  for (const m of pending) {
    // 迁移语句在前，迁移记录在后。drizzle 的 D1 batch 不支持带绑定参数的原始 SQL，
    // 因此迁移记录写成字面量（tag 来自内嵌的迁移列表，单引号按 SQL 规则转义）
    const tag = `'${m.tag.replaceAll("'", "''")}'`
    const batch: [BatchItem, ...BatchItem[]] = [
      db.run(sql.raw(`INSERT INTO \`${TABLE}\` (tag, applied_at) VALUES (${tag}, ${Date.now()})`)),
    ]
    batch.unshift(...splitStatements(m.sql).map((s) => db.run(sql.raw(s))))
    try {
      await db.batch(batch)
      done.push(m.tag)
    } catch (e) {
      const rows = await db.all(sql`SELECT 1 FROM ${sql.identifier(TABLE)} WHERE tag = ${m.tag}`)
      if (rows.length === 0) throw e
    }
  }
  return done
}
