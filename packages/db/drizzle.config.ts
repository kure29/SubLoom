import { defineConfig } from 'drizzle-kit'

// 只用于生成迁移：pnpm --filter @subloom/db db:generate（见 PLAN.md 5.2）
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
})
