import { describe, expect, it } from 'vitest'
import {
  detectRegion,
  flagOf,
  type PipelineOp,
  PipelineSchema,
  type ProxyNode,
  runPipeline,
} from '../src/index.js'

function ss(name: string, server = 's.example.com', port = 8388): ProxyNode {
  return { name, type: 'ss', server, port, cipher: 'aes-128-gcm', password: 'p' }
}

function trojan(name: string, server = 't.example.com', port = 443): ProxyNode {
  return { name, type: 'trojan', server, port, password: 'p', tls: {} }
}

function run(nodes: ProxyNode[], ops: PipelineOp[]) {
  return runPipeline(nodes, PipelineSchema.parse(ops))
}

const names = (r: { nodes: ProxyNode[] }) => r.nodes.map((n) => n.name)

describe('detectRegion', () => {
  it.each([
    ['🇭🇰 香港 01 | SS', 'HK'],
    ['🇹🇼 台湾 01', 'TW'],
    ['香港 IPLC 02', 'HK'],
    ['HK-01', 'HK'],
    ['Hong Kong 03', 'HK'],
    ['日本 东京 01', 'JP'],
    ['Tokyo 02', 'JP'],
    ['🇺🇸 美国 01', 'US'],
    ['US 01', 'US'],
    ['United States 02', 'US'],
    ['洛杉矶 01', 'US'],
    ['新加坡 01', 'SG'],
    ['韩国 首尔', 'KR'],
    ['英国 01', 'GB'],
    ['UK London', 'GB'],
    ['德国 01', 'DE'],
    ['印度尼西亚 01', 'ID'],
    ['印度 01', 'IN'],
    ['澳门 01', 'MO'],
    ['澳大利亚 01', 'AU'],
    ['俄罗斯 01', 'RU'],
    // 未在地区表中的国旗也能识别
    ['🇮🇸 冰岛 01', 'IS'],
  ])('%s → %s', (name, code) => {
    expect(detectRegion(name)).toBe(code)
  })

  it.each([
    '剩余流量：98.5 GB',
    '套餐到期：2027-01-01',
    'PLUS 01',
    'BONUS',
    'status',
    'Duplicate Name',
  ])('does not guess a region for %s', (name) => {
    expect(detectRegion(name)).toBeUndefined()
  })

  it('prefers the flag over keywords', () => {
    expect(detectRegion('🇯🇵 香港中转 日本')).toBe('JP')
  })

  it('builds flag emoji from region codes', () => {
    expect(flagOf('HK')).toBe('🇭🇰')
    expect(flagOf('us')).toBe('🇺🇸')
  })
})

describe('PipelineSchema', () => {
  it('accepts every op', () => {
    const ops = [
      { op: 'filter-regex', pattern: 'a', mode: 'keep' },
      { op: 'filter-type', types: ['ss'], mode: 'drop' },
      { op: 'filter-region', regions: ['HK'], mode: 'keep' },
      { op: 'rename-regex', pattern: 'a', replace: 'b' },
      { op: 'add-flag' },
      { op: 'sort', by: 'name', order: 'asc' },
      { op: 'dedupe', by: 'server' },
      { op: 'prefix', text: '[A] ' },
      { op: 'suffix', text: ' [A]' },
    ]
    expect(PipelineSchema.parse(ops)).toEqual(ops)
  })

  it.each([
    { op: 'eval', code: '1' },
    { op: 'filter-type', types: ['snell'], mode: 'keep' },
    { op: 'filter-region', regions: ['hk'], mode: 'keep' },
    { op: 'filter-regex', pattern: 'a', mode: 'maybe' },
    { op: 'add-flag', extra: true },
  ])('rejects %j', (op) => {
    expect(PipelineSchema.safeParse([op]).success).toBe(false)
  })
})

describe('runPipeline', () => {
  const sample = [
    ss('剩余流量：98.5 GB', 'info.example.com', 1),
    ss('🇭🇰 香港 01'),
    trojan('日本 02', 'jp.example.com'),
    ss('US 03', 'us.example.com'),
    trojan('Unknown 04', 'x.example.com'),
  ]

  it('returns the input unchanged without ops and does not mutate it', () => {
    const input = structuredClone(sample)
    const r = run(input, [{ op: 'prefix', text: 'x' }])
    expect(input).toEqual(sample)
    expect(run(sample, [])).toEqual({ nodes: sample, warnings: [] })
    expect(r.nodes).not.toBe(input)
  })

  it('filters by regex in keep and drop mode, with (?i)', () => {
    expect(
      names(run(sample, [{ op: 'filter-regex', pattern: '剩余|到期', mode: 'drop' }])),
    ).toEqual(['🇭🇰 香港 01', '日本 02', 'US 03', 'Unknown 04'])
    expect(
      names(run(sample, [{ op: 'filter-regex', pattern: '(?i)unknown|us', mode: 'keep' }])),
    ).toEqual(['US 03', 'Unknown 04'])
  })

  it('filters by type', () => {
    expect(names(run(sample, [{ op: 'filter-type', types: ['trojan'], mode: 'keep' }]))).toEqual([
      '日本 02',
      'Unknown 04',
    ])
    expect(names(run(sample, [{ op: 'filter-type', types: ['ss'], mode: 'drop' }]))).toEqual([
      '日本 02',
      'Unknown 04',
    ])
  })

  it('filters by region; unknown regions are dropped by keep and kept by drop', () => {
    expect(
      names(run(sample, [{ op: 'filter-region', regions: ['HK', 'JP'], mode: 'keep' }])),
    ).toEqual(['🇭🇰 香港 01', '日本 02'])
    expect(names(run(sample, [{ op: 'filter-region', regions: ['HK'], mode: 'drop' }]))).toEqual([
      '剩余流量：98.5 GB',
      '日本 02',
      'US 03',
      'Unknown 04',
    ])
  })

  it('renames with a global regex replacement and capture groups', () => {
    expect(
      names(
        run([ss('A-1-B-2')], [{ op: 'rename-regex', pattern: '(\\w)-(\\d)', replace: '$2$1' }]),
      ),
    ).toEqual(['1A-2B'])
  })

  it('adds flags only when a region is detected and the name has no flag yet', () => {
    expect(names(run(sample, [{ op: 'add-flag' }]))).toEqual([
      '剩余流量：98.5 GB',
      '🇭🇰 香港 01',
      '🇯🇵 日本 02',
      '🇺🇸 US 03',
      'Unknown 04',
    ])
  })

  it('sorts by name with numeric collation, stable, both orders', () => {
    const nodes = [ss('b 10'), ss('a 2'), ss('b 2'), ss('a 2', 'other.example.com')]
    const asc = run(nodes, [{ op: 'sort', by: 'name', order: 'asc' }]).nodes
    expect(asc.map((n) => [n.name, n.server])).toEqual([
      ['a 2', 's.example.com'],
      ['a 2', 'other.example.com'],
      ['b 2', 's.example.com'],
      ['b 10', 's.example.com'],
    ])
    expect(names(run(nodes, [{ op: 'sort', by: 'name', order: 'desc' }]))).toEqual([
      'b 10',
      'b 2',
      'a 2',
      'a 2',
    ])
  })

  it('sorts by region table order and keeps unknown regions last in both orders', () => {
    const nodes = [ss('US 1'), ss('Other'), ss('日本 1'), ss('香港 1'), ss('US 2')]
    expect(names(run(nodes, [{ op: 'sort', by: 'region', order: 'asc' }]))).toEqual([
      '香港 1',
      '日本 1',
      'US 1',
      'US 2',
      'Other',
    ])
    expect(names(run(nodes, [{ op: 'sort', by: 'region', order: 'desc' }]))).toEqual([
      'US 1',
      'US 2',
      '日本 1',
      '香港 1',
      'Other',
    ])
  })

  it('dedupes by name, keeping the first', () => {
    const r = run(
      [ss('a', 'x.example.com'), ss('b'), ss('a', 'y.example.com')],
      [{ op: 'dedupe', by: 'name' }],
    )
    expect(r.nodes.map((n) => [n.name, n.server])).toEqual([
      ['a', 'x.example.com'],
      ['b', 's.example.com'],
    ])
  })

  it('dedupes by type + server + port', () => {
    const r = run(
      [
        ss('a', 'x.example.com', 1),
        ss('b', 'x.example.com', 1),
        ss('c', 'x.example.com', 2),
        trojan('d', 'x.example.com', 1),
      ],
      [{ op: 'dedupe', by: 'server' }],
    )
    expect(names(r)).toEqual(['a', 'c', 'd'])
  })

  it('adds prefixes and suffixes', () => {
    expect(
      names(
        run(
          [ss('a')],
          [
            { op: 'prefix', text: '[X] ' },
            { op: 'suffix', text: ' ✓' },
          ],
        ),
      ),
    ).toEqual(['[X] a ✓'])
  })

  it('applies ops in order', () => {
    expect(
      names(
        run(sample, [
          { op: 'filter-regex', pattern: '剩余', mode: 'drop' },
          { op: 'add-flag' },
          { op: 'filter-region', regions: ['US', 'JP'], mode: 'keep' },
          { op: 'sort', by: 'region', order: 'asc' },
        ]),
      ),
    ).toEqual(['🇯🇵 日本 02', '🇺🇸 US 03'])
  })

  it('skips ops with an invalid regex and warns, without stopping the pipeline', () => {
    const r = run(sample, [
      { op: 'filter-regex', pattern: '(', mode: 'keep' },
      { op: 'rename-regex', pattern: '[', replace: '' },
      { op: 'prefix', text: '> ' },
    ])
    expect(names(r)).toEqual(sample.map((n) => `> ${n.name}`))
    expect(r.warnings).toEqual([
      expect.objectContaining({ level: 'warn', code: 'INVALID_REGEX', path: 'pipeline[0]' }),
      expect.objectContaining({ level: 'warn', code: 'INVALID_REGEX', path: 'pipeline[1]' }),
    ])
  })

  it('warns when a rename produces an empty name and keeps the old one', () => {
    const r = run([ss('abc')], [{ op: 'rename-regex', pattern: '.*', replace: '' }])
    expect(names(r)).toEqual(['abc'])
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: 'EMPTY_NAME', path: 'pipeline[0]' }),
    ])
  })
})
