import { describe, expect, it } from 'vitest'
import journal from '../migrations/meta/_journal.json' with { type: 'json' }
import { migrations, splitStatements } from '../src/index.js'

const files = import.meta.glob<string>('../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('内嵌的迁移', () => {
  it('与 drizzle-kit 生成的 SQL 文件逐字节一致（修改 schema 后运行 pnpm --filter @subloom/db db:generate）', () => {
    expect(migrations.map((m) => m.tag)).toEqual(journal.entries.map((e) => e.tag))
    expect(Object.keys(files).sort()).toEqual(
      journal.entries.map((e) => `../migrations/${e.tag}.sql`).sort(),
    )
    for (const m of migrations) expect(m.sql).toBe(files[`../migrations/${m.tag}.sql`])
  })

  it('迁移名按顺序排列且不重复', () => {
    const tags = migrations.map((m) => m.tag)
    expect(new Set(tags).size).toBe(tags.length)
    expect([...tags].sort()).toEqual(tags)
  })
})

describe('splitStatements', () => {
  it('按 statement-breakpoint 拆分，去掉空白和空语句', () => {
    expect(
      splitStatements(
        'CREATE TABLE a (x);\n--> statement-breakpoint\nCREATE INDEX i ON a (x);--> statement-breakpoint\n',
      ),
    ).toEqual(['CREATE TABLE a (x);', 'CREATE INDEX i ON a (x);'])
  })

  it('初始迁移创建全部 5 张表', () => {
    const first = migrations[0]
    expect(first?.tag).toMatch(/^0000_/)
    const tables = splitStatements(first?.sql ?? '')
      .map((s) => /^CREATE TABLE `(\w+)`/.exec(s)?.[1])
      .filter(Boolean)
      .sort()
    expect(tables).toEqual(['fetch_logs', 'outputs', 'profiles', 'settings', 'sources'])
  })
})
