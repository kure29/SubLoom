import { describe, expect, it } from 'vitest'
import { type ImportResult, importSubscription, type ProxyNode, ProxySchema } from '../src/index.js'

const inputs = import.meta.glob<string>('./fixtures/import/*/input.*', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const cases = Object.entries(inputs)
  .map(([path, text]) => ({ name: path.split('/').at(-2) ?? path, text }))
  .sort((a, b) => a.name.localeCompare(b.name))

const results = new Map(cases.map((c) => [c.name, importSubscription(c.text)]))

function result(name: string): ImportResult {
  const r = results.get(name)
  if (!r) throw new Error(`fixture not found: ${name}`)
  return r
}

const names = (proxies: ProxyNode[]) => proxies.map((p) => p.name)

/** 交叉一致性比较时忽略 udp（URI 无法表达）和 extra（键空间随来源格式不同） */
function comparable(p: ProxyNode): Omit<ProxyNode, 'udp' | 'extra'> {
  const { udp: _udp, extra: _extra, ...rest } = p
  return rest
}

const MIXED_NAMES = [
  '剩余流量：98.5 GB',
  '套餐到期：2027-01-01',
  '🇭🇰 香港 01 | SS',
  '🇭🇰 香港 02 | SS2022',
  '🇯🇵 日本 01 | SS+obfs',
  '🇯🇵 日本 02 | VMess WS',
  '🇺🇸 美国 01 | VMess gRPC',
  '🇺🇸 美国 02 | VLESS Reality',
  '🇸🇬 新加坡 01 | VLESS WS',
  '🇸🇬 新加坡 02 | Trojan',
  '🇹🇼 台湾 01 | Trojan WS',
  '🇰🇷 韩国 01 | Hysteria2',
  '🇩🇪 德国 01 | IPv6',
]
const YAML_NAMES = [
  ...MIXED_NAMES.slice(0, 12),
  '🇩🇪 德国 01 | IPv6',
  '🇬🇧 英国 01 | TUIC',
  '🇫🇷 法国 01 | AnyTLS',
]

describe('golden: import fixtures', () => {
  it('finds the fixture cases', () => {
    expect(cases.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'mihomo-airport-full',
        'mihomo-proxies-only',
        'uri-edge-cases',
        'uri-mixed',
        'uri-mixed-b64',
        'uri-mixed-b64-wrapped',
        'uri-mixed-b64url-nopad',
      ]),
    )
  })

  it.each(cases)('$name matches expected.ir.json', async ({ name }) => {
    await expect(`${JSON.stringify(result(name), null, 2)}\n`).toMatchFileSnapshot(
      `./fixtures/import/${name}/expected.ir.json`,
    )
  })

  it.each(cases)('$name produces schema-valid proxies', ({ name }) => {
    for (const proxy of result(name).proxies) {
      expect(ProxySchema.parse(proxy)).toEqual(proxy)
    }
  })
})

describe('mihomo YAML', () => {
  it('imports 15 proxies in source order from both files', () => {
    for (const name of ['mihomo-airport-full', 'mihomo-proxies-only']) {
      const r = result(name)
      expect(r.format).toBe('mihomo-yaml')
      expect(names(r.proxies)).toEqual(YAML_NAMES)
      expect(r.warnings).toEqual([])
    }
  })

  it('imports the same proxies from the full config and the provider-style file', () => {
    expect(result('mihomo-proxies-only').proxies).toEqual(result('mihomo-airport-full').proxies)
    expect(result('mihomo-proxies-only').config).toBeUndefined()
  })

  it('parses groups, rule sets and rules of the full config', () => {
    const config = result('mihomo-airport-full').config
    if (!config) throw new Error('config missing')

    expect(config.general).toEqual({ mixedPort: 7890, mode: 'rule', logLevel: 'info' })

    expect(config.groups.map((g) => [g.name, g.type])).toEqual([
      ['节点选择', 'select'],
      ['自动选择', 'url-test'],
      ['故障转移', 'fallback'],
      ['香港节点', 'url-test'],
    ])
    const [select, auto, , hk] = config.groups
    expect(select?.members.slice(0, 4)).toEqual([
      { kind: 'group', name: '自动选择' },
      { kind: 'group', name: '故障转移' },
      { kind: 'builtin', name: 'DIRECT' },
      { kind: 'proxy', name: '🇭🇰 香港 01 | SS' },
    ])
    expect(select?.members).toHaveLength(16)
    expect(auto).toMatchObject({
      testUrl: 'https://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
    })
    expect(hk).toEqual({
      name: '香港节点',
      type: 'url-test',
      members: [],
      includeAllProxies: true,
      filter: { include: '(?i)港|hk|hong ?kong' },
      testUrl: 'https://www.gstatic.com/generate_204',
      interval: 300,
    })

    expect(config.ruleSets).toEqual([
      {
        id: 'reject',
        name: 'reject',
        behavior: 'domain',
        sources: { mihomo: { url: 'https://example.com/rules/reject.yaml', format: 'yaml' } },
        interval: 86400,
        extra: { mihomo: { path: './ruleset/reject.yaml' } },
      },
    ])

    expect(config.rules).toEqual([
      { type: 'RULE-SET', value: 'reject', target: 'REJECT' },
      { type: 'DOMAIN-SUFFIX', value: 'local', target: 'DIRECT' },
      { type: 'DOMAIN', value: 'example-direct.com', target: 'DIRECT' },
      { type: 'DOMAIN-KEYWORD', value: 'google', target: '节点选择' },
      { type: 'IP-CIDR', value: '192.168.0.0/16', target: 'DIRECT', noResolve: true },
      { type: 'IP-CIDR6', value: 'fe80::/10', target: 'DIRECT', noResolve: true },
      {
        type: 'AND',
        children: [
          { type: 'DOMAIN-SUFFIX', value: 'example.org' },
          { type: 'DST-PORT', value: '443' },
        ],
        target: '香港节点',
      },
      { type: 'GEOSITE', value: 'cn', target: 'DIRECT' },
      { type: 'GEOIP', value: 'CN', target: 'DIRECT' },
      { type: 'MATCH', target: '节点选择' },
    ])

    // allow-lan: false 是已映射字段，按规范形式省略，不进入 extra
    expect(config.extra).toBeUndefined()
  })
})

describe('URI lists', () => {
  it('imports 13 proxies in source order from the plain list', () => {
    const r = result('uri-mixed')
    expect(r.format).toBe('uri-list')
    expect(names(r.proxies)).toEqual(MIXED_NAMES)
    expect(r.warnings).toEqual([])
  })

  it.each(['uri-mixed-b64', 'uri-mixed-b64-wrapped', 'uri-mixed-b64url-nopad'])(
    '%s imports exactly the same as the plain list',
    (name) => {
      const r = result(name)
      expect(r.format).toBe('base64-uri-list')
      expect(r.proxies).toEqual(result('uri-mixed').proxies)
      expect(r.warnings).toEqual(result('uri-mixed').warnings)
    },
  )

  it('agrees with the YAML importer on the 13 shared proxies (cross-consistency)', () => {
    const yaml = new Map(result('mihomo-airport-full').proxies.map((p) => [p.name, p]))
    const uri = result('uri-mixed').proxies
    expect(uri).toHaveLength(13)
    for (const p of uri) {
      const y = yaml.get(p.name)
      expect(y, p.name).toBeDefined()
      if (y) expect(comparable(p), p.name).toEqual(comparable(y))
    }
  })
})

describe('uri-edge-cases', () => {
  const r = () => result('uri-edge-cases')

  it('imports 8 proxies in source order', () => {
    expect(names(r().proxies)).toEqual([
      'Legacy SS',
      'noname.example.com:8388',
      'VMess 数字端口 无TLS',
      'VLESS 无加密',
      'hy2 别名协议',
      'Port Hopping',
      'Duplicate Name',
      'Duplicate Name',
    ])
  })

  it('parses each valid line as expected', () => {
    const [legacy, noname, vmess, vless, hy2, hop, dup1, dup2] = r().proxies
    expect(legacy).toEqual({
      name: 'Legacy SS',
      type: 'ss',
      server: 'legacy.example.com',
      port: 8388,
      cipher: 'aes-128-gcm',
      password: 'legacy-pass',
    })
    expect(noname).toEqual({
      name: 'noname.example.com:8388',
      type: 'ss',
      server: 'noname.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'noname',
    })
    expect(vmess).toEqual({
      name: 'VMess 数字端口 无TLS',
      type: 'vmess',
      server: '198.51.100.20',
      port: 10086,
      uuid: '00000000-0000-4000-8000-000000000006',
      alterId: 0,
      cipher: 'auto',
    })
    expect(vless).toEqual({
      name: 'VLESS 无加密',
      type: 'vless',
      server: 'plain.example.com',
      port: 80,
      uuid: '00000000-0000-4000-8000-000000000007',
    })
    expect(hy2).toEqual({
      name: 'hy2 别名协议',
      type: 'hysteria2',
      server: 'hy2.example.com',
      port: 443,
      password: 'fake-pass-hy2',
      tls: { sni: 'hy2.example.com', skipCertVerify: true },
    })
    expect(hop).toEqual({
      name: 'Port Hopping',
      type: 'hysteria2',
      server: 'hop.example.com',
      port: 20000,
      ports: '20000-30000',
      password: 'fake-pass-hop',
      tls: { sni: 'hop.example.com' },
    })
    expect(dup1).toMatchObject({ type: 'trojan', server: 'dup.example.com' })
    expect(dup2).toMatchObject({ type: 'trojan', server: 'dup2.example.com' })
  })

  it('warns once for each skipped line, with line number and protocol', () => {
    expect(r().warnings).toEqual([
      expect.objectContaining({ level: 'warn', code: 'INVALID_PROXY', line: 5, protocol: 'vmess' }),
      expect.objectContaining({
        level: 'warn',
        code: 'UNSUPPORTED_PROTOCOL',
        line: 11,
        protocol: 'tuic',
      }),
      expect.objectContaining({
        level: 'warn',
        code: 'UNSUPPORTED_PROTOCOL',
        line: 12,
        protocol: 'ssr',
      }),
      expect.objectContaining({
        level: 'warn',
        code: 'UNSUPPORTED_PROTOCOL',
        line: 13,
        protocol: 'https',
      }),
      expect.objectContaining({ level: 'warn', code: 'INVALID_URI', line: 14 }),
    ])
  })

  it('never echoes the raw link in warning messages', () => {
    for (const w of r().warnings) {
      expect(w.message).not.toMatch(/fake-pass|this-is-not-base64|example\.com/)
    }
  })
})
