import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // setup 把全局 fetch 换成直接抛错的函数，测试中不访问真实网络
    setupFiles: ['./test/setup.ts'],
    unstubGlobals: true,
  },
})
