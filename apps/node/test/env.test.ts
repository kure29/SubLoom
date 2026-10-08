import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/env.js'

describe('readConfig', () => {
  it('全部可选，默认值见 PLAN.md 第 6 节', () => {
    expect(readConfig({})).toEqual({
      port: 3000,
      dataDir: './data',
      refreshIntervalMin: 10,
      env: {
        adminToken: undefined,
        secretKey: undefined,
        corsOrigins: [],
        allowPrivateFetch: false,
        publicUrl: undefined,
        trustProxy: false,
      },
    })
  })

  it('读取各项配置，空字符串视为未设置', () => {
    const config = readConfig({
      PORT: '8080',
      DATA_DIR: '/data',
      REFRESH_INTERVAL_MIN: '0',
      ADMIN_TOKEN: ' token ',
      SECRET_KEY: '',
      CORS_ORIGINS: 'https://a.example.com/, https://b.example.com ,',
      ALLOW_PRIVATE_FETCH: 'true',
      PUBLIC_URL: 'https://sub.example.com/',
      TRUST_PROXY: 'yes',
    })
    expect(config).toEqual({
      port: 8080,
      dataDir: '/data',
      refreshIntervalMin: 0,
      env: {
        adminToken: 'token',
        secretKey: undefined,
        corsOrigins: ['https://a.example.com', 'https://b.example.com'],
        allowPrivateFetch: true,
        publicUrl: 'https://sub.example.com',
        trustProxy: true,
      },
    })
  })

  it('ALLOW_PRIVATE_FETCH 只有 true/1/yes 才开启', () => {
    for (const v of ['false', '0', 'no', 'TRUEISH']) {
      expect(readConfig({ ALLOW_PRIVATE_FETCH: v }).env.allowPrivateFetch).toBe(false)
    }
    for (const v of ['TRUE', '1', 'yes']) {
      expect(readConfig({ ALLOW_PRIVATE_FETCH: v }).env.allowPrivateFetch).toBe(true)
    }
  })

  it('环境变量的解析与 Workers 共用 parseEnv', () => {
    expect(() => readConfig({ PUBLIC_URL: 'not a url' })).toThrow(/PUBLIC_URL/)
  })

  it('数字不合法时报错', () => {
    expect(() => readConfig({ PORT: 'abc' })).toThrow(/PORT/)
    expect(() => readConfig({ REFRESH_INTERVAL_MIN: '-1' })).toThrow(/REFRESH_INTERVAL_MIN/)
  })
})
