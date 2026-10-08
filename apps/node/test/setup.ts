import { beforeEach, vi } from 'vitest'

// 测试中不得访问真实网络：每个测试开始前把全局 fetch 换成直接抛错的函数，需要时在测试中再 mock。
// 配合 vitest 配置 unstubGlobals: true，每个测试结束后恢复。
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('real network access is disabled in tests: mock fetch instead')
    }),
  )
})
