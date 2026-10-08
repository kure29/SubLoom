import { lookup } from 'node:dns/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type SubloomDb, schema } from '@subloom/db'
import type { Platform, PlatformEnv } from '@subloom/server'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createFileBlobStore } from './blob-store.js'

/** better-sqlite3 的 Drizzle 实例。filename 为 ':memory:' 时用内存数据库（测试）。 */
export function openDatabase(filename: string): { db: SubloomDb; close(): void } {
  const sqlite = new Database(filename)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  return { db: drizzle(sqlite, { schema }), close: () => sqlite.close() }
}

/** 解析出的全部地址，供 server 做 SSRF 检查 */
export async function resolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true })
  return records.map((r) => r.address)
}

export function waitUntil(p: Promise<unknown>): void {
  p.catch((e: unknown) => console.error('[subloom] background task failed:', e))
}

/** 数据目录：subloom.db（SQLite）、blobs/（文件 BlobStore）。见 PLAN.md 第 6 节。 */
export async function createNodePlatform(
  dataDir: string,
  env: PlatformEnv,
): Promise<{ platform: Platform; close(): void }> {
  await mkdir(dataDir, { recursive: true })
  const { db, close } = openDatabase(join(dataDir, 'subloom.db'))
  const blobs = await createFileBlobStore(join(dataDir, 'blobs'))
  return { platform: { db, blobs, env, waitUntil, resolveHost }, close }
}
