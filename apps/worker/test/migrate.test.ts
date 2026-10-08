import { type Migration, migrate, migrations } from '@subloom/db'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '../src/platform.js'
import { nextBindings, resetStorage } from './storage.js'

// D1 不支持交互式事务：每个迁移连同迁移记录用 db.batch 一次提交。见 PLAN.md 第 6 节。
beforeEach(resetStorage)

async function tables(d1: D1Database): Promise<string[]> {
  const { results } = await d1
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all<{ name: string }>()
  return results.map((r) => r.name)
}

async function applied(d1: D1Database): Promise<string[]> {
  const { results } = await d1
    .prepare('SELECT tag FROM __subloom_migrations ORDER BY tag')
    .all<{ tag: string }>()
  return results.map((r) => r.tag)
}

describe('migrate on D1', () => {
  it('执行全部迁移，再次执行时什么都不做', async () => {
    const { d1 } = nextBindings()
    const tags = migrations.map((m) => m.tag)
    expect(await migrate(createDb(d1))).toEqual(tags)
    expect(await tables(d1)).toEqual(
      ['__subloom_migrations', 'fetch_logs', 'outputs', 'profiles', 'settings', 'sources'].sort(),
    )
    expect(await applied(d1)).toEqual(tags)
    expect(await migrate(createDb(d1))).toEqual([])
  })

  it('只执行尚未执行的迁移', async () => {
    const { d1 } = nextBindings()
    const [first, ...rest] = migrations
    if (!first) throw new Error('no migrations')
    expect(await migrate(createDb(d1), [first])).toEqual([first.tag])
    expect(await migrate(createDb(d1))).toEqual(rest.map((m) => m.tag))
    const columns = await d1.prepare('PRAGMA table_info(sources)').all<{ name: string }>()
    expect(columns.results.map((c) => c.name)).toContain('nodes_fetched_at')
  })

  it('并发执行时每个迁移只执行一次，都不报错', async () => {
    const { d1 } = nextBindings()
    const results = await Promise.all([
      migrate(createDb(d1)),
      migrate(createDb(d1)),
      migrate(createDb(d1)),
    ])
    expect(results.flat().sort()).toEqual(migrations.map((m) => m.tag).sort())
    expect(await applied(d1)).toEqual(migrations.map((m) => m.tag))
  })

  it('迁移中任一语句失败时整体回滚，不记录', async () => {
    const { d1 } = nextBindings()
    const bad: Migration[] = [
      { tag: '0000_ok', sql: 'CREATE TABLE `a` (`x` integer);' },
      {
        tag: '0001_bad',
        sql: 'CREATE TABLE `b` (`x` integer);\n--> statement-breakpoint\nINSERT INTO `missing` VALUES (1);',
      },
    ]
    await expect(migrate(createDb(d1), bad)).rejects.toThrow()
    expect(await tables(d1)).toEqual(['__subloom_migrations', 'a'])
    expect(await applied(d1)).toEqual(['0000_ok'])
  })
})
