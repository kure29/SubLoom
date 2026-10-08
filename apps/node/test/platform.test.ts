import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, migrations, sources } from '@subloom/db'
import { bootstrap } from '@subloom/server'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodePlatform, openDatabase, resolveHost } from '../src/platform.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) =>
    host === 'dual.example.com'
      ? [
          { address: '93.184.215.14', family: 4 },
          { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
        ]
      : [],
  ),
}))

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subloom-platform-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('migrate（better-sqlite3）', () => {
  it('执行全部迁移，重复执行不报错', async () => {
    const { db, close } = openDatabase(':memory:')
    expect(await migrate(db)).toEqual(migrations.map((m) => m.tag))
    expect(await migrate(db)).toEqual([])
    const tables = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    expect(tables.map((t) => t.name)).toEqual([
      '__subloom_migrations',
      'fetch_logs',
      'outputs',
      'profiles',
      'settings',
      'sources',
    ])
    close()
  })

  it('并发执行时只执行一次', async () => {
    const { db, close } = openDatabase(':memory:')
    const results = await Promise.all([migrate(db), migrate(db), migrate(db)])
    expect(results.flat()).toEqual(migrations.map((m) => m.tag))
    close()
  })

  it('开启了外键约束', async () => {
    const { db, close } = openDatabase(':memory:')
    expect(await db.all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 1 }])
    close()
  })
})

describe('createNodePlatform', () => {
  it('在数据目录中创建 SQLite 数据库和 blobs 目录，重启后数据保留', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = { secretKey: 'k', corsOrigins: [], allowPrivateFetch: false }
    const first = await createNodePlatform(join(dir, 'data'), env)
    await bootstrap(first.platform)
    await first.platform.blobs.put('src:x:nodes', '[]')
    first.close()
    expect((await readdir(join(dir, 'data'))).sort()).toEqual(
      expect.arrayContaining(['blobs', 'subloom.db']),
    )

    const second = await createNodePlatform(join(dir, 'data'), env)
    await bootstrap(second.platform)
    expect(await second.platform.blobs.get('src:x:nodes')).toBe('[]')
    expect(await second.platform.db.select().from(sources)).toEqual([])
    second.close()
  })
})

describe('resolveHost', () => {
  it('返回 DNS 解析出的全部地址（IPv4 和 IPv6）', async () => {
    expect(await resolveHost('dual.example.com')).toEqual([
      '93.184.215.14',
      '2606:2800:21f:cb07:6820:80da:af6b:8b2c',
    ])
  })
})
