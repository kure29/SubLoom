import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/** 测试用的 D1、KV 绑定对数：同一个测试中可能需要多份独立的存储（如 restore 到新实例） */
export const STORAGE_PAIRS = 4

const range = (prefix: string) => Array.from({ length: STORAGE_PAIRS }, (_, i) => `${prefix}${i}`)

// 在 workerd（miniflare）中运行测试。D1、KV 直接在这里声明，不读取根目录的 wrangler.jsonc
// （其中的静态资源目录需要先构建前端；配置本身由 `pnpm build` 中的 wrangler deploy --dry-run 校验）。
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        // 与根目录 wrangler.jsonc 的 compatibility_date 一致
        compatibilityDate: '2026-08-15',
        d1Databases: range('DB'),
        kvNamespaces: range('KV'),
      },
    }),
  ],
  test: {
    // setup 把全局 fetch 换成直接抛错的函数，测试中不访问真实网络
    setupFiles: ['./test/setup.ts'],
    unstubGlobals: true,
  },
})
