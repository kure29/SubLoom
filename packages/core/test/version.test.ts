import { describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { CORE_VERSION } from '../src/index.js'

describe('CORE_VERSION', () => {
  // server 的生成结果缓存键包含 core 版本，发布时随 package.json 一起修改
  it('matches package.json', () => {
    expect(CORE_VERSION).toBe(pkg.version)
  })
})
