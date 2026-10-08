import { describe, expect, it } from 'vitest'
import { parseEnv } from '../src/env.js'

// Node（process.env）和 Workers（env 中的 vars、secrets）共用的环境变量解析。见 PLAN.md 5.1。
describe('parseEnv', () => {
  it('全部可选', () => {
    expect(parseEnv({})).toEqual({
      adminToken: undefined,
      secretKey: undefined,
      corsOrigins: [],
      allowPrivateFetch: false,
      publicUrl: undefined,
      trustProxy: false,
    })
  })

  it('读取各项配置，空字符串视为未设置', () => {
    expect(
      parseEnv({
        ADMIN_TOKEN: ' token ',
        SECRET_KEY: '',
        CORS_ORIGINS: 'https://a.example.com/, https://b.example.com ,',
        ALLOW_PRIVATE_FETCH: 'true',
        PUBLIC_URL: 'https://sub.example.com/',
        TRUST_PROXY: '1',
      }),
    ).toEqual({
      adminToken: 'token',
      secretKey: undefined,
      corsOrigins: ['https://a.example.com', 'https://b.example.com'],
      allowPrivateFetch: true,
      publicUrl: 'https://sub.example.com',
      trustProxy: true,
    })
  })

  it('忽略非字符串的值（Workers 的 env 中还有 D1、KV 等绑定）', () => {
    expect(parseEnv({ DB: {}, ADMIN_TOKEN: 't', TRUST_PROXY: true })).toMatchObject({
      adminToken: 't',
      trustProxy: false,
    })
  })

  it.each(['ALLOW_PRIVATE_FETCH', 'TRUST_PROXY'] as const)('%s 只有 true/1/yes 才开启', (name) => {
    const key = name === 'TRUST_PROXY' ? 'trustProxy' : 'allowPrivateFetch'
    for (const v of ['false', '0', 'no', 'TRUEISH', ''])
      expect(parseEnv({ [name]: v })[key]).toBe(false)
    for (const v of ['TRUE', '1', 'yes', ' Yes ']) expect(parseEnv({ [name]: v })[key]).toBe(true)
  })

  it('PUBLIC_URL：去掉末尾的 /，保留路径前缀', () => {
    expect(parseEnv({ PUBLIC_URL: 'https://example.com/subloom/' }).publicUrl).toBe(
      'https://example.com/subloom',
    )
    expect(parseEnv({ PUBLIC_URL: 'http://192.168.1.2:3000' }).publicUrl).toBe(
      'http://192.168.1.2:3000',
    )
  })

  it('PUBLIC_URL 不合法时报错', () => {
    for (const v of [
      'sub.example.com',
      'ftp://sub.example.com',
      'https://sub.example.com/?a=1',
      'https://sub.example.com/#x',
      'https://user:pass@sub.example.com',
    ]) {
      expect(() => parseEnv({ PUBLIC_URL: v }), v).toThrow(/PUBLIC_URL/)
    }
  })
})
