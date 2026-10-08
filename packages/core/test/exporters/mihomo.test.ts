import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  type ExportOptions,
  exportMihomo,
  importMihomoYaml,
  mihomoExporter,
  type Profile,
  type ProxyNode,
} from '../../src/index.js'

type Doc = Record<string, unknown> & {
  proxies: Array<Record<string, unknown>>
  'proxy-groups'?: Array<Record<string, unknown>>
  'rule-providers'?: Record<string, Record<string, unknown>>
  rules?: string[]
}

function profile(p: Partial<Profile> = {}): Profile {
  return { version: 1, name: 'test', proxies: [], groups: [], rules: [], ruleSets: [], ...p }
}

function ss(name: string, extra: Partial<ProxyNode> = {}): ProxyNode {
  return {
    name,
    type: 'ss',
    server: 's.example.com',
    port: 8388,
    cipher: 'aes-128-gcm',
    password: 'p',
    ...extra,
  } as ProxyNode
}

function exp(p: Profile, nodes: ProxyNode[] = [], opts?: ExportOptions) {
  const r = exportMihomo(p, nodes, opts)
  return { doc: parse(r.text) as Doc, text: r.text, warnings: r.warnings }
}

/** 只导出一个节点，返回输出中的节点对象 */
function one(node: ProxyNode, opts?: ExportOptions): Record<string, unknown> {
  const { doc, warnings } = exp(profile(), [node], opts)
  expect(warnings).toEqual([])
  const [p] = doc.proxies
  if (!p) throw new Error('no proxy')
  return p
}

const codes = (warnings: Array<{ code: string; path: string; action: string }>) =>
  warnings.map((w) => [w.code, w.path, w.action])

describe('exporter object', () => {
  it('targets mihomo and declares its capabilities', () => {
    expect(mihomoExporter.target).toBe('mihomo')
    expect(mihomoExporter.capabilities.logicalRules).toBe(true)
    expect(mihomoExporter.capabilities.proxyTypes).toContain('hysteria2')
    expect(mihomoExporter.capabilities.groupTypes).toContain('load-balance')
    expect(mihomoExporter.capabilities.ruleSetFormats).toEqual(['yaml', 'text', 'mrs'])
    expect(mihomoExporter.export(profile(), [])).toEqual(exportMihomo(profile(), []))
  })
})

describe('udp', () => {
  it('writes the explicit value', () => {
    expect(one(ss('a', { udp: true })).udp).toBe(true)
    expect(one(ss('a', { udp: false })).udp).toBe(false)
  })

  it('falls back to defaultUdp (true by default) when udp is not set', () => {
    expect(one(ss('a')).udp).toBe(true)
    expect(one(ss('a'), { defaultUdp: true }).udp).toBe(true)
    expect(one(ss('a'), { defaultUdp: false }).udp).toBe(false)
    expect(one(ss('a', { udp: true }), { defaultUdp: false }).udp).toBe(true)
  })
})

describe('proxies', () => {
  it('writes fields in a stable order', () => {
    expect(Object.keys(one(ss('a', { tfo: true })))).toEqual([
      'name',
      'type',
      'server',
      'port',
      'cipher',
      'password',
      'udp',
      'tfo',
    ])
  })

  it('maps vless reality over grpc', () => {
    expect(
      one({
        name: 'v',
        type: 'vless',
        server: 'v.example.com',
        port: 443,
        udp: true,
        uuid: 'u',
        flow: 'xtls-rprx-vision',
        tls: {
          sni: 's.example.com',
          clientFingerprint: 'chrome',
          reality: { publicKey: 'K', shortId: '01' },
        },
        transport: { type: 'grpc', serviceName: 'svc' },
      }),
    ).toEqual({
      name: 'v',
      type: 'vless',
      server: 'v.example.com',
      port: 443,
      uuid: 'u',
      flow: 'xtls-rprx-vision',
      udp: true,
      tls: true,
      servername: 's.example.com',
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': 'K', 'short-id': '01' },
      network: 'grpc',
      'grpc-opts': { 'grpc-service-name': 'svc' },
    })
  })

  it('maps ws and httpupgrade with Host headers', () => {
    const base = { name: 'v', type: 'vmess', server: 'v.example.com', port: 443, uuid: 'u' }
    expect(
      one({
        ...base,
        type: 'vmess',
        alterId: 0,
        cipher: 'auto',
        transport: {
          type: 'ws',
          path: '/ws',
          host: 'h.example.com',
          headers: { 'User-Agent': 'ua' },
          maxEarlyData: 2048,
          earlyDataHeaderName: 'Sec-WebSocket-Protocol',
        },
      }),
    ).toMatchObject({
      alterId: 0,
      cipher: 'auto',
      network: 'ws',
      'ws-opts': {
        path: '/ws',
        headers: { Host: 'h.example.com', 'User-Agent': 'ua' },
        'max-early-data': 2048,
        'early-data-header-name': 'Sec-WebSocket-Protocol',
      },
    })
    expect(
      one({
        ...base,
        type: 'vless',
        transport: { type: 'httpupgrade', path: '/up', host: 'h.example.com' },
      }),
    ).toMatchObject({
      network: 'ws',
      'ws-opts': { path: '/up', headers: { Host: 'h.example.com' }, 'v2ray-http-upgrade': true },
    })
  })

  it('omits empty transport options', () => {
    const p = one({
      name: 'v',
      type: 'vless',
      server: 'v.example.com',
      port: 443,
      uuid: 'u',
      transport: { type: 'ws' },
    })
    expect(p.network).toBe('ws')
    expect(p).not.toHaveProperty('ws-opts')
  })

  it('maps h2 and http transports', () => {
    const base = {
      name: 'v',
      type: 'vless',
      server: 'v.example.com',
      port: 443,
      uuid: 'u',
    } as const
    expect(
      one({ ...base, transport: { type: 'h2', path: '/h2', host: ['a.example.com'] } }),
    ).toMatchObject({ network: 'h2', 'h2-opts': { path: '/h2', host: ['a.example.com'] } })
    expect(
      one({
        ...base,
        transport: {
          type: 'http',
          method: 'GET',
          path: ['/'],
          host: ['a.example.com'],
          headers: { Connection: ['keep-alive'] },
        },
      }),
    ).toMatchObject({
      network: 'http',
      'http-opts': {
        method: 'GET',
        path: ['/'],
        headers: { Host: ['a.example.com'], Connection: ['keep-alive'] },
      },
    })
  })

  it('maps ss plugins', () => {
    expect(
      one(ss('a', { plugin: { type: 'obfs', mode: 'http', host: 'b.example.com' } })),
    ).toMatchObject({ plugin: 'obfs', 'plugin-opts': { mode: 'http', host: 'b.example.com' } })
    expect(
      one(
        ss('a', {
          plugin: {
            type: 'v2ray-plugin',
            mode: 'websocket',
            host: 'h.example.com',
            path: '/ws',
            tls: true,
            skipCertVerify: true,
          },
        }),
      ),
    ).toMatchObject({
      plugin: 'v2ray-plugin',
      'plugin-opts': {
        mode: 'websocket',
        host: 'h.example.com',
        path: '/ws',
        tls: true,
        'skip-cert-verify': true,
      },
    })
  })

  it('maps hysteria2 port hopping, obfs and numeric bandwidth', () => {
    expect(
      one({
        name: 'h',
        type: 'hysteria2',
        server: '2001:db8::1',
        port: 443,
        ports: '443,20000-30000',
        password: 'p',
        obfs: { type: 'salamander', password: 'o' },
        up: '50',
        down: '200 Mbps',
        tls: { sni: 's.example.com', skipCertVerify: true },
      }),
    ).toEqual({
      name: 'h',
      type: 'hysteria2',
      server: '2001:db8::1',
      port: 443,
      password: 'p',
      ports: '443,20000-30000',
      up: 50,
      down: '200 Mbps',
      obfs: 'salamander',
      'obfs-password': 'o',
      udp: true,
      sni: 's.example.com',
      'skip-cert-verify': true,
    })
  })

  it('maps trojan TLS options without a tls key', () => {
    const p = one({
      name: 't',
      type: 'trojan',
      server: 't.example.com',
      port: 443,
      password: 'p',
      tls: {
        sni: 's.example.com',
        alpn: ['h2'],
        certFingerprint: 'AB',
        ech: { config: 'Q0ZH' },
      },
    })
    expect(p).not.toHaveProperty('tls')
    expect(p).toMatchObject({
      sni: 's.example.com',
      alpn: ['h2'],
      fingerprint: 'AB',
      'ech-opts': { enable: true, config: 'Q0ZH' },
    })
  })

  it('merges extra.mihomo deeply, IR fields first', () => {
    const p = one({
      name: 'v',
      type: 'vless',
      server: 'v.example.com',
      port: 443,
      uuid: 'u',
      transport: { type: 'ws', path: '/ws' },
      extra: {
        mihomo: {
          'ip-version': 'ipv4',
          'ws-opts': { 'v2ray-http-upgrade-fast-open': true, path: '/ignored' },
          uuid: 'ignored',
        },
      },
    })
    expect(p).toMatchObject({
      uuid: 'u',
      'ip-version': 'ipv4',
      'ws-opts': { path: '/ws', 'v2ray-http-upgrade-fast-open': true },
    })
  })

  it('warns about extra from other formats', () => {
    const { warnings, doc } = exp(profile(), [
      ss('a', { extra: { uri: { plugin: 'shadow-tls;host=a' } } }),
    ])
    expect(doc.proxies[0]).not.toHaveProperty('plugin')
    expect(warnings).toEqual([
      expect.objectContaining({
        level: 'warn',
        code: 'EXTRA_IGNORED',
        path: 'nodes[0].extra.uri',
        action: 'dropped',
      }),
    ])
  })

  it('quotes strings that YAML 1.1 would read as other types', () => {
    const { text, doc } = exp(profile(), [
      ss('yes', { password: '01234567' }),
      ss('1_000', { password: '12e4' }),
      ss('0x1F', { password: 'true' }),
    ])
    expect(doc.proxies.map((p) => [p.name, p.password])).toEqual([
      ['yes', '01234567'],
      ['1_000', '12e4'],
      ['0x1F', 'true'],
    ])
    for (const s of ['yes', '01234567', '1_000', '12e4', '0x1F', 'true']) {
      expect(text).toMatch(new RegExp(`["']${s}["']`))
    }
  })

  it('does not fold long lines', () => {
    const name = `long ${'x'.repeat(200)}`
    expect(exp(profile(), [ss(name)]).text).toContain(`name: ${name}\n`)
  })

  it('puts manual proxies before subscription nodes', () => {
    const { doc } = exp(profile({ proxies: [ss('manual')] }), [ss('sub')])
    expect(doc.proxies.map((p) => p.name)).toEqual(['manual', 'sub'])
  })
})

describe('name conflicts', () => {
  it('renames duplicate proxies and points references at the first one', () => {
    const { doc, warnings } = exp(
      profile({
        proxies: [ss('a')],
        groups: [{ name: 'G', type: 'select', members: [{ kind: 'proxy', name: 'a' }] }],
        rules: [{ type: 'MATCH', target: 'a' }],
      }),
      [ss('a', { server: 'x.example.com' }), ss('a 2'), ss('a', { server: 'y.example.com' })],
    )
    expect(doc.proxies.map((p) => [p.name, p.server])).toEqual([
      ['a', 's.example.com'],
      ['a 3', 'x.example.com'],
      ['a 2', 's.example.com'],
      ['a 4', 'y.example.com'],
    ])
    expect(doc['proxy-groups']?.[0]?.proxies).toEqual(['a'])
    expect(doc.rules).toEqual(['MATCH,a'])
    expect(codes(warnings)).toEqual([
      ['DUPLICATE_PROXY_NAME', 'nodes[0]', 'kept'],
      ['DUPLICATE_PROXY_NAME', 'nodes[2]', 'kept'],
    ])
  })

  it('renames proxies that clash with group names or built-in targets', () => {
    const { doc, warnings } = exp(
      profile({
        groups: [
          {
            name: 'G',
            type: 'select',
            members: [
              { kind: 'proxy', name: 'G' },
              { kind: 'proxy', name: 'DIRECT' },
            ],
          },
        ],
        rules: [{ type: 'MATCH', target: 'G' }],
      }),
      [ss('G'), ss('DIRECT'), ss('REJECT')],
    )
    expect(doc.proxies.map((p) => p.name)).toEqual(['G 2', 'DIRECT 2', 'REJECT 2'])
    expect(doc['proxy-groups']?.[0]?.proxies).toEqual(['G 2', 'DIRECT 2'])
    expect(doc.rules).toEqual(['MATCH,G'])
    expect(codes(warnings)).toEqual([
      ['DUPLICATE_PROXY_NAME', 'nodes[0]', 'kept'],
      ['DUPLICATE_PROXY_NAME', 'nodes[1]', 'kept'],
      ['DUPLICATE_PROXY_NAME', 'nodes[2]', 'kept'],
    ])
  })

  it('drops duplicate groups, keeping the first', () => {
    const { doc, warnings } = exp(
      profile({
        groups: [
          { name: 'G', type: 'select', members: [{ kind: 'builtin', name: 'DIRECT' }] },
          { name: 'G', type: 'url-test', members: [{ kind: 'builtin', name: 'REJECT' }] },
        ],
      }),
    )
    expect(doc['proxy-groups']).toEqual([{ name: 'G', type: 'select', proxies: ['DIRECT'] }])
    expect(codes(warnings)).toEqual([['DUPLICATE_GROUP_NAME', 'groups[1]', 'dropped']])
  })
})

describe('groups', () => {
  it('maps every field', () => {
    const { doc } = exp(
      profile({
        groups: [
          {
            name: 'Auto',
            type: 'url-test',
            members: [{ kind: 'builtin', name: 'DIRECT' }],
            includeAllProxies: true,
            filter: { include: '(?i)hk', exclude: 'x' },
            testUrl: 'https://cp.example.com/generate_204',
            interval: 300,
            tolerance: 50,
            hidden: true,
            icon: 'https://icon.example.com/a.png',
            extra: { mihomo: { lazy: true } },
          },
        ],
      }),
    )
    expect(doc['proxy-groups']).toEqual([
      {
        name: 'Auto',
        type: 'url-test',
        proxies: ['DIRECT'],
        'include-all-proxies': true,
        filter: '(?i)hk',
        'exclude-filter': 'x',
        url: 'https://cp.example.com/generate_204',
        interval: 300,
        tolerance: 50,
        hidden: true,
        icon: 'https://icon.example.com/a.png',
        lazy: true,
      },
    ])
  })

  it('omits proxies when a group only includes all proxies', () => {
    const { doc } = exp(
      profile({ groups: [{ name: 'A', type: 'select', members: [], includeAllProxies: true }] }),
    )
    expect(doc['proxy-groups']).toEqual([
      { name: 'A', type: 'select', 'include-all-proxies': true },
    ])
  })

  it('removes dangling members and fills empty groups with DIRECT', () => {
    const { doc, warnings } = exp(
      profile({
        groups: [
          {
            name: 'A',
            type: 'select',
            members: [
              { kind: 'proxy', name: 'missing' },
              { kind: 'group', name: 'B' },
              { kind: 'group', name: 'nope' },
              { kind: 'proxy', name: 'n' },
            ],
          },
          { name: 'B', type: 'fallback', members: [{ kind: 'proxy', name: 'gone' }] },
          {
            name: 'C',
            type: 'select',
            members: [],
            extra: { mihomo: { use: ['provider1'] } },
          },
        ],
      }),
      [ss('n')],
    )
    expect(doc['proxy-groups']?.map((g) => [g.name, g.proxies])).toEqual([
      ['A', ['B', 'n']],
      ['B', ['DIRECT']],
      ['C', undefined],
    ])
    expect(codes(warnings)).toEqual([
      ['UNKNOWN_GROUP_MEMBER', 'groups[0].members[0]', 'dropped'],
      ['UNKNOWN_GROUP_MEMBER', 'groups[0].members[2]', 'dropped'],
      ['UNKNOWN_GROUP_MEMBER', 'groups[1].members[0]', 'dropped'],
      ['EMPTY_GROUP', 'groups[1]', 'downgraded'],
    ])
  })
})

describe('rules', () => {
  const groups: Profile['groups'] = [
    { name: 'G', type: 'select', members: [{ kind: 'builtin', name: 'DIRECT' }] },
  ]

  it('formats parameters and logical rules', () => {
    const { doc, warnings } = exp(
      profile({
        groups,
        rules: [
          { type: 'DOMAIN-SUFFIX', value: 'a.example.com', target: 'G' },
          { type: 'IP-CIDR', value: '10.0.0.0/8', noResolve: true, target: 'DIRECT' },
          { type: 'IP-CIDR', value: '10.0.0.0/8', src: true, target: 'DIRECT' },
          { type: 'GEOIP', value: 'CN', src: true, noResolve: true, target: 'DIRECT' },
          {
            type: 'OR',
            children: [
              { type: 'NOT', children: [{ type: 'DOMAIN', value: 'a.example.com' }] },
              {
                type: 'AND',
                children: [
                  { type: 'IP-CIDR', value: '10.0.0.0/8', src: true },
                  { type: 'IP-CIDR6', value: 'fd00::/8', noResolve: true },
                ],
              },
            ],
            target: 'REJECT',
          },
          { type: 'MATCH', target: 'G' },
        ],
      }),
    )
    expect(doc.rules).toEqual([
      'DOMAIN-SUFFIX,a.example.com,G',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,10.0.0.0/8,DIRECT,src',
      'GEOIP,CN,DIRECT,src,no-resolve',
      'OR,((NOT,((DOMAIN,a.example.com))),(AND,((IP-CIDR,10.0.0.0/8,src),(IP-CIDR6,fd00::/8,no-resolve)))),REJECT',
      'MATCH,G',
    ])
    expect(warnings).toEqual([])
  })

  it('round-trips rules through the importer', () => {
    const lines = [
      'IP-CIDR,10.0.0.0/8,DIRECT,src',
      'AND,((IP-CIDR,10.0.0.0/8,src),(DST-PORT,22)),REJECT',
      'OR,((NOT,((DOMAIN,a.example.com))),(AND,((DST-PORT,80),(SRC-IP-CIDR,10.0.0.0/8)))),DIRECT',
      'MATCH,DIRECT',
    ]
    const imported = importMihomoYaml(
      `proxies: []\nrules:\n${lines.map((l) => `  - ${JSON.stringify(l)}`).join('\n')}\n`,
    )
    const rules = imported.config?.rules ?? []
    expect(exp(profile({ rules })).doc.rules).toEqual(lines)
  })

  it('drops rules with unknown targets and keeps proxy targets', () => {
    const { doc, warnings } = exp(
      profile({
        groups,
        rules: [
          { type: 'DOMAIN', value: 'a.example.com', target: 'nowhere' },
          { type: 'DOMAIN', value: 'b.example.com', target: 'n' },
          { type: 'DOMAIN', value: 'c.example.com', target: 'REJECT-DROP' },
          { type: 'MATCH', target: 'G' },
        ],
      }),
      [ss('n')],
    )
    expect(doc.rules).toEqual([
      'DOMAIN,b.example.com,n',
      'DOMAIN,c.example.com,REJECT-DROP',
      'MATCH,G',
    ])
    expect(codes(warnings)).toEqual([['UNKNOWN_RULE_TARGET', 'rules[0]', 'dropped']])
  })
})

describe('rule sets', () => {
  const set = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      name: id,
      behavior: 'domain',
      sources: { mihomo: { url: `https://r.example.com/${id}.yaml`, format: 'yaml' } },
      ...over,
    }) as Profile['ruleSets'][number]

  it('writes rule-providers keyed by id', () => {
    const { doc, warnings } = exp(
      profile({
        ruleSets: [
          set('ads', {
            name: 'Ads',
            interval: 86400,
            extra: { mihomo: { path: './ruleset/ads.yaml', proxy: 'DIRECT' } },
          }),
          set('ip', {
            behavior: 'ipcidr',
            sources: { mihomo: { url: 'https://r.example.com/ip.mrs', format: 'mrs' } },
          }),
        ],
        rules: [
          { type: 'RULE-SET', value: 'ads', target: 'REJECT' },
          { type: 'RULE-SET', value: 'ip', noResolve: true, src: true, target: 'DIRECT' },
        ],
      }),
    )
    expect(doc['rule-providers']).toEqual({
      ads: {
        type: 'http',
        behavior: 'domain',
        format: 'yaml',
        url: 'https://r.example.com/ads.yaml',
        interval: 86400,
        path: './ruleset/ads.yaml',
        proxy: 'DIRECT',
      },
      ip: {
        type: 'http',
        behavior: 'ipcidr',
        format: 'mrs',
        url: 'https://r.example.com/ip.mrs',
        proxy: 'DIRECT',
      },
    })
    expect(doc.rules).toEqual(['RULE-SET,ads,REJECT', 'RULE-SET,ip,DIRECT,src,no-resolve'])
    expect(warnings).toEqual([])
  })

  describe('download policy and mirror', () => {
    const groups: Profile['groups'] = [
      { name: 'Auto', type: 'url-test', members: [{ kind: 'builtin', name: 'DIRECT' }] },
      { name: 'Proxy', type: 'select', members: [{ kind: 'group', name: 'Auto' }] },
    ]
    const RAW = 'https://raw.githubusercontent.com/o/r/master/rule/Clash/a.yaml'
    const p = profile({
      groups,
      ruleSets: [
        set('a', {
          sources: { mihomo: { url: RAW, format: 'yaml' } },
          extra: { mihomo: { proxy: 'Auto' } },
        }),
      ],
      rules: [{ type: 'RULE-SET', value: 'a', target: 'Proxy' }],
    })
    const provider = (opts?: ExportOptions) => {
      const { doc, warnings } = exp(p, [], opts)
      return { provider: doc['rule-providers']?.a, warnings }
    }

    it('downloads through the first select group by default, overriding extra', () => {
      const { provider: a, warnings } = provider()
      expect(a?.proxy).toBe('Proxy')
      expect(Object.keys(a ?? {})).toEqual(['type', 'behavior', 'format', 'url', 'proxy'])
      expect(warnings).toEqual([
        expect.objectContaining({
          level: 'info',
          code: 'EXTRA_IGNORED',
          path: 'ruleSets[0].extra.mihomo.proxy',
        }),
      ])
    })

    it('uses the chosen policy', () => {
      expect(provider({ ruleSetPolicy: 'Auto' })).toEqual({
        provider: expect.objectContaining({ proxy: 'Auto' }),
        warnings: [],
      })
      expect(provider({ ruleSetPolicy: 'DIRECT' }).provider?.proxy).toBe('DIRECT')
    })

    it('falls back to DIRECT when the chosen group is gone', () => {
      const { provider: a, warnings } = provider({ ruleSetPolicy: '节点选择' })
      expect(a?.proxy).toBe('DIRECT')
      expect(codes(warnings)).toEqual([
        ['UNKNOWN_RULE_SET_POLICY', 'options.ruleSetPolicy', 'downgraded'],
        ['EXTRA_IGNORED', 'ruleSets[0].extra.mihomo.proxy', 'dropped'],
      ])
    })

    it('rewrites URLs for the mirror', () => {
      expect(provider({ ruleSetMirror: 'jsdelivr' }).provider?.url).toBe(
        'https://cdn.jsdelivr.net/gh/o/r@master/rule/Clash/a.yaml',
      )
      expect(provider({ ruleSetMirror: { prefix: 'https://m.example.com/' } }).provider?.url).toBe(
        `https://m.example.com/${RAW}`,
      )
    })
  })

  it('drops unusable rule sets and the rules that reference them', () => {
    const { doc, warnings } = exp(
      profile({
        ruleSets: [
          set('surge-only', {
            sources: { surge: { url: 'https://r.example.com/a.list', format: 'list' } },
          }),
          set('list', {
            sources: { mihomo: { url: 'https://r.example.com/a.list', format: 'list' } },
          }),
          set('classical-mrs', {
            behavior: 'classical',
            sources: { mihomo: { url: 'https://r.example.com/a.mrs', format: 'mrs' } },
          }),
          set('ok'),
        ],
        rules: [
          { type: 'RULE-SET', value: 'surge-only', target: 'DIRECT' },
          {
            type: 'AND',
            children: [
              { type: 'RULE-SET', value: 'list' },
              { type: 'DST-PORT', value: '443' },
            ],
            target: 'DIRECT',
          },
          { type: 'RULE-SET', value: 'missing', target: 'DIRECT' },
          { type: 'RULE-SET', value: 'ok', target: 'DIRECT' },
        ],
      }),
    )
    expect(Object.keys(doc['rule-providers'] ?? {})).toEqual(['ok'])
    expect(doc.rules).toEqual(['RULE-SET,ok,DIRECT'])
    expect(codes(warnings)).toEqual([
      ['RULE_SET_NO_SOURCE', 'ruleSets[0]', 'dropped'],
      ['UNSUPPORTED_RULE_SET_FORMAT', 'ruleSets[1]', 'dropped'],
      ['UNSUPPORTED_RULE_SET_FORMAT', 'ruleSets[2]', 'dropped'],
      ['UNKNOWN_RULE_SET', 'rules[0]', 'dropped'],
      ['UNKNOWN_RULE_SET', 'rules[1]', 'dropped'],
      ['UNKNOWN_RULE_SET', 'rules[2]', 'dropped'],
    ])
  })
})

describe('top level', () => {
  it('writes general, extra, dns and sections in order', () => {
    const { text, doc } = exp(
      profile({
        general: {
          mixedPort: 7890,
          allowLan: true,
          mode: 'rule',
          logLevel: 'info',
          ipv6: true,
          extra: { mihomo: { 'unified-delay': true } },
        },
        dns: {
          enable: true,
          enhancedMode: 'fake-ip',
          fakeIpRange: '198.18.0.1/16',
          nameserver: ['https://dns.example.com/dns-query'],
          extra: { mihomo: { 'fake-ip-filter': ['*.lan'] } },
        },
        extra: { mihomo: { tun: { enable: true }, 'mixed-port': 1 } },
        groups: [{ name: 'G', type: 'select', members: [{ kind: 'builtin', name: 'DIRECT' }] }],
        ruleSets: [
          {
            id: 'r',
            name: 'r',
            behavior: 'domain',
            sources: { mihomo: { url: 'https://r.example.com/r.yaml', format: 'yaml' } },
          },
        ],
        rules: [{ type: 'MATCH', target: 'G' }],
      }),
      [ss('a')],
    )
    expect(Object.keys(doc)).toEqual([
      'mixed-port',
      'allow-lan',
      'mode',
      'log-level',
      'ipv6',
      'unified-delay',
      'tun',
      'dns',
      'proxies',
      'proxy-groups',
      'rule-providers',
      'rules',
    ])
    expect(doc['mixed-port']).toBe(7890)
    expect(doc.dns).toEqual({
      enable: true,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      nameserver: ['https://dns.example.com/dns-query'],
      'fake-ip-filter': ['*.lan'],
    })
    expect(text.endsWith('\n')).toBe(true)
  })

  it('always writes proxies, even when empty, and skips empty sections', () => {
    expect(exp(profile()).doc).toEqual({ proxies: [] })
  })
})

describe('round trip', () => {
  it('re-imports exported proxies unchanged', () => {
    const yaml = `proxies:
  - { name: a, type: vless, server: v.example.com, port: 443, uuid: u, tls: true, servername: s.example.com, network: ws, ws-opts: { path: /ws, headers: { Host: h.example.com } }, smux: { enabled: true } }
  - { name: b, type: hysteria2, server: h.example.com, port: 443, udp: false, password: p, up: 50 }
`
    const first = importMihomoYaml(yaml).proxies
    const { text } = exp(profile(), first)
    expect(importMihomoYaml(text).proxies).toEqual(first)
  })
})
