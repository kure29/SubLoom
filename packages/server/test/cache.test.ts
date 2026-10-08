import { describe, expect, it } from 'vitest'
import { type CacheKeyInput, cacheKeys } from '../src/outputs/cache.js'

// 生成结果缓存键：任一输入变化都会自动失效。见 PLAN.md 5.3"生成结果缓存"。
const base: CacheKeyInput = {
  coreVersion: '1.0.0',
  target: 'mihomo',
  profile: { irJson: '{"name":"a"}', pipelineJson: '[]', sourceIdsJson: '["s1","s2"]' },
  optionsJson: '{}',
  providerUrl: null,
  nodes: [
    ['s1', 1000],
    ['s2', null],
  ],
}

describe('cacheKeys', () => {
  it('相同输入得到相同的键（十六进制 SHA-256）', async () => {
    const a = await cacheKeys(base)
    expect(a.configKey).toMatch(/^[0-9a-f]{64}$/)
    expect(a.nodesKey).toMatch(/^[0-9a-f]{64}$/)
    expect(await cacheKeys({ ...base, nodes: [...(base.nodes ?? [])] })).toEqual(a)
  })

  const configChanges: Array<[string, Partial<CacheKeyInput>]> = [
    ['core 版本', { coreVersion: '1.0.1' }],
    ['target', { target: 'surge' }],
    ['profile IR', { profile: { ...base.profile, irJson: '{"name":"b"}' } }],
    ['流水线', { profile: { ...base.profile, pipelineJson: '[{"op":"add-flag"}]' } }],
    ['订阅源', { profile: { ...base.profile, sourceIdsJson: '["s2","s1"]' } }],
    ['导出选项', { optionsJson: '{"export":{"defaultUdp":false}}' }],
    ['provider 地址', { providerUrl: 'https://x.example.com/sub/T/proxies' }],
  ]

  it.each(configChanges)('%s变化时 configKey 变化，nodesKey 不变', async (_label, change) => {
    const a = await cacheKeys(base)
    const b = await cacheKeys({ ...base, ...change })
    expect(b.configKey).not.toBe(a.configKey)
    expect(b.nodesKey).toBe(a.nodesKey)
  })

  it('节点缓存版本变化时只有 nodesKey 变化', async () => {
    const a = await cacheKeys(base)
    for (const nodes of [
      [
        ['s1', 2000],
        ['s2', null],
      ],
      [
        ['s1', 1000],
        ['s2', 3000],
      ],
      [['s1', 1000]],
    ] as Array<Array<[string, number | null]>>) {
      const b = await cacheKeys({ ...base, nodes })
      expect(b.configKey).toBe(a.configKey)
      expect(b.nodesKey).not.toBe(a.nodesKey)
    }
  })

  it('不含订阅节点（nodes 为 null）时 nodesKey 为空串', async () => {
    expect((await cacheKeys({ ...base, nodes: null })).nodesKey).toBe('')
  })

  it('字段之间没有拼接歧义', async () => {
    const a = await cacheKeys({
      ...base,
      profile: { ...base.profile, irJson: 'a', pipelineJson: 'bc' },
    })
    const b = await cacheKeys({
      ...base,
      profile: { ...base.profile, irJson: 'ab', pipelineJson: 'c' },
    })
    expect(a.configKey).not.toBe(b.configKey)
  })
})
