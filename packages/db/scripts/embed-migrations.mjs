// 把 drizzle-kit 生成的 SQL 迁移内嵌为 src/migrations.gen.ts，使 migrate(db) 不依赖文件系统（Workers 可用）。
// 由 `pnpm --filter @subloom/db db:generate` 在 drizzle-kit generate 之后调用。见 PLAN.md 5.2。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const journal = JSON.parse(readFileSync(new URL('migrations/meta/_journal.json', root), 'utf8'))
const migrations = journal.entries.map((e) => ({
  tag: e.tag,
  sql: readFileSync(new URL(`migrations/${e.tag}.sql`, root), 'utf8'),
}))

const out = fileURLToPath(new URL('src/migrations.gen.ts', root))
writeFileSync(
  out,
  `// 由 scripts/embed-migrations.mjs 根据 migrations/ 生成，不要手动修改。\n` +
    `import type { Migration } from './migrate.js'\n\n` +
    `export const migrations: readonly Migration[] = ${JSON.stringify(migrations, null, 2)}\n`,
)
execFileSync('pnpm', ['-w', 'exec', 'biome', 'format', '--write', out], { stdio: 'inherit' })
