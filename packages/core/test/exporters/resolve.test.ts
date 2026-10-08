import { describe, expect, it } from 'vitest'
import { ExportContext, resolveProfile, type TargetSpec } from '../../src/exporters/resolve.js'
import type { ExportOptions, Profile, ProxyNode, RuleSet } from '../../src/index.js'

/** 一个能力受限的虚构客户端，用来测试与具体客户端无关的降级和清理逻辑 */
const LIMITED: TargetSpec = {
  target: 'surge',
  capabilities: {
    proxyTypes: ['ss', 'trojan'],
    groupTypes: ['select', 'url-test'],
    ruleTypes: ['DOMAIN', 'DOMAIN-SUFFIX', 'IP-CIDR', 'GEOIP', 'RULE-SET', 'MATCH'],
    logicalRules: false,
    ruleSetFormats: ['list'],
    ruleSetProxy: false,
  },
  builtins: new Set(['DIRECT', 'REJECT', 'REJECT-DROP']),
  ruleSetSource: (set) =>
    set.sources.surge ?? { code: 'RULE_SET_NO_SOURCE', message: 'no surge source' },
  adaptProxy(node, warn) {
    if (node.type === 'trojan' && node.transport) {
      warn('UNSUPPORTED_PROXY_FEATURE', 'transport', 'dropped', 'no transport')
      return undefined
    }
    if (node.type === 'trojan' && node.tls.clientFingerprint) {
      warn('UNSUPPORTED_PROXY_FEATURE', 'tls.clientFingerprint', 'downgraded', 'no uTLS')
      const { clientFingerprint: _, ...tls } = node.tls
      return { ...node, tls }
    }
    return node
  },
}

/** 与 LIMITED 相同，但支持通过策略组下载规则集 */
const PROXIED: TargetSpec = {
  ...LIMITED,
  capabilities: { ...LIMITED.capabilities, ruleSetProxy: true },
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

function set(id: string, url = `https://r.example.com/${id}.list`): RuleSet {
  return { id, name: id, behavior: 'classical', sources: { surge: { url, format: 'list' } } }
}

function resolve(p: Profile, nodes: ProxyNode[] = [], opts: ExportOptions = {}, spec = LIMITED) {
  const ctx = new ExportContext(spec.target)
  const r = resolveProfile(spec, p, nodes, opts, ctx)
  return { ...r, warnings: ctx.warnings }
}

const codes = (warnings: Array<{ code: string; path: string; action: string }>) =>
  warnings.map((w) => [w.code, w.path, w.action])

describe('unsupported proxy types', () => {
  it('drops the node and every reference to it', () => {
    const r = resolve(
      profile({
        proxies: [{ name: 'hy', type: 'hysteria2', server: 'h.example.com', port: 443, tls: {} }],
        groups: [
          {
            name: 'G',
            type: 'select',
            members: [
              { kind: 'proxy', name: 'hy' },
              { kind: 'proxy', name: 'a' },
            ],
          },
          { name: 'Only hy', type: 'select', members: [{ kind: 'proxy', name: 'hy' }] },
        ],
        rules: [
          { type: 'DOMAIN', value: 'a.example.com', target: 'hy' },
          { type: 'MATCH', target: 'G' },
        ],
      }),
      [ss('a')],
    )
    expect(r.proxies.map((p) => p.name)).toEqual(['a'])
    expect(r.groups.map((g) => [g.group.name, g.members])).toEqual([
      ['G', ['a']],
      ['Only hy', ['DIRECT']],
    ])
    expect(r.rules.map((x) => [x.rule.type, x.target])).toEqual([['MATCH', 'G']])
    expect(codes(r.warnings)).toEqual([
      ['UNSUPPORTED_PROXY_TYPE', 'proxies[0]', 'dropped'],
      ['UNKNOWN_GROUP_MEMBER', 'groups[0].members[0]', 'dropped'],
      ['UNKNOWN_GROUP_MEMBER', 'groups[1].members[0]', 'dropped'],
      ['EMPTY_GROUP', 'groups[1]', 'downgraded'],
      ['UNKNOWN_RULE_TARGET', 'rules[0]', 'dropped'],
    ])
  })

  it('does not reserve names for dropped nodes', () => {
    const r = resolve(profile(), [
      {
        name: 'a',
        type: 'vmess',
        server: 'v.example.com',
        port: 443,
        uuid: 'u',
        alterId: 0,
        cipher: 'auto',
      },
      ss('a'),
    ])
    expect(r.proxies.map((p) => [p.name, p.path])).toEqual([['a', 'nodes[1]']])
    expect(codes(r.warnings)).toEqual([['UNSUPPORTED_PROXY_TYPE', 'nodes[0]', 'dropped']])
  })
})

describe('unsupported proxy features', () => {
  const trojan = (name: string, over: Record<string, unknown> = {}): ProxyNode =>
    ({
      name,
      type: 'trojan',
      server: 't.example.com',
      port: 443,
      password: 'p',
      tls: {},
      ...over,
    }) as ProxyNode

  it('drops nodes when the target says so and cleans up references', () => {
    const r = resolve(
      profile({
        groups: [{ name: 'G', type: 'select', members: [{ kind: 'proxy', name: 'ws' }] }],
      }),
      [trojan('ws', { transport: { type: 'ws', path: '/' } })],
    )
    expect(r.proxies).toEqual([])
    expect(codes(r.warnings)).toEqual([
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[0].transport', 'dropped'],
      ['UNKNOWN_GROUP_MEMBER', 'groups[0].members[0]', 'dropped'],
      ['EMPTY_GROUP', 'groups[0]', 'downgraded'],
    ])
  })

  it('keeps the node the target adapted', () => {
    const r = resolve(profile(), [trojan('fp', { tls: { sni: 'a', clientFingerprint: 'chrome' } })])
    expect(r.proxies.map((p) => p.node)).toEqual([trojan('fp', { tls: { sni: 'a' } })])
    expect(codes(r.warnings)).toEqual([
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[0].tls.clientFingerprint', 'downgraded'],
    ])
  })
})

describe('unsupported group types', () => {
  it('downgrades load-balance and fallback to url-test', () => {
    const r = resolve(
      profile({
        groups: [
          { name: 'LB', type: 'load-balance', members: [{ kind: 'builtin', name: 'DIRECT' }] },
          { name: 'FB', type: 'fallback', members: [{ kind: 'builtin', name: 'DIRECT' }] },
          { name: 'S', type: 'select', members: [{ kind: 'builtin', name: 'DIRECT' }] },
        ],
      }),
    )
    expect(r.groups.map((g) => [g.group.name, g.type])).toEqual([
      ['LB', 'url-test'],
      ['FB', 'url-test'],
      ['S', 'select'],
    ])
    expect(codes(r.warnings)).toEqual([
      ['UNSUPPORTED_GROUP_TYPE', 'groups[0].type', 'downgraded'],
      ['UNSUPPORTED_GROUP_TYPE', 'groups[1].type', 'downgraded'],
    ])
  })
})

describe('unsupported rules', () => {
  it('drops rules of unsupported types, logical rules and their children', () => {
    const r = resolve(
      profile({
        rules: [
          { type: 'GEOSITE', value: 'google', target: 'DIRECT' },
          {
            type: 'AND',
            children: [
              { type: 'DOMAIN', value: 'a.example.com' },
              { type: 'DST-PORT', value: '443' },
            ],
            target: 'DIRECT',
          },
          { type: 'DOMAIN', value: 'b.example.com', target: 'DIRECT' },
          { type: 'MATCH', target: 'DIRECT' },
        ],
      }),
    )
    expect(r.rules.map((x) => x.path)).toEqual(['rules[2]', 'rules[3]'])
    expect(codes(r.warnings)).toEqual([
      ['UNSUPPORTED_RULE_TYPE', 'rules[0]', 'dropped'],
      ['UNSUPPORTED_RULE_TYPE', 'rules[1]', 'dropped'],
    ])
  })

  it('lets the target reject rules by parameter', () => {
    const spec: TargetSpec = {
      ...LIMITED,
      checkRule: (c) => (c.src ? 'src is not supported' : undefined),
    }
    const r = resolve(
      profile({
        rules: [
          { type: 'IP-CIDR', value: '10.0.0.0/8', src: true, target: 'DIRECT' },
          { type: 'IP-CIDR', value: '10.0.0.0/8', target: 'DIRECT' },
        ],
      }),
      [],
      {},
      spec,
    )
    expect(r.rules.map((x) => x.path)).toEqual(['rules[1]'])
    expect(codes(r.warnings)).toEqual([['UNSUPPORTED_RULE_PARAM', 'rules[0]', 'dropped']])
  })
})

describe('rule set download policy', () => {
  const groups: Profile['groups'] = [
    { name: 'Auto', type: 'url-test', members: [{ kind: 'builtin', name: 'DIRECT' }] },
    { name: 'Proxy', type: 'select', members: [{ kind: 'builtin', name: 'DIRECT' }] },
    { name: 'Other', type: 'select', members: [{ kind: 'builtin', name: 'DIRECT' }] },
  ]
  const p = profile({
    groups,
    ruleSets: [set('a')],
    rules: [{ type: 'RULE-SET', value: 'a', target: 'Proxy' }],
  })

  it('defaults to the first select group', () => {
    const r = resolve(p, [], {}, PROXIED)
    expect(r.ruleSetPolicy).toBe('Proxy')
    expect(r.warnings).toEqual([])
  })

  it('defaults to DIRECT without a select group', () => {
    const r = resolve({ ...p, groups: groups.slice(0, 1), rules: [] }, [], {}, PROXIED)
    expect(r.ruleSetPolicy).toBe('DIRECT')
    expect(r.warnings).toEqual([])
  })

  it('uses the chosen group or DIRECT', () => {
    expect(resolve(p, [], { ruleSetPolicy: 'Other' }, PROXIED).ruleSetPolicy).toBe('Other')
    expect(resolve(p, [], { ruleSetPolicy: 'Auto' }, PROXIED).ruleSetPolicy).toBe('Auto')
    expect(resolve(p, [], { ruleSetPolicy: 'DIRECT' }, PROXIED).ruleSetPolicy).toBe('DIRECT')
  })

  it('falls back to DIRECT when the chosen group was removed or renamed', () => {
    const r = resolve(p, [], { ruleSetPolicy: 'Renamed' }, PROXIED)
    expect(r.ruleSetPolicy).toBe('DIRECT')
    expect(codes(r.warnings)).toEqual([
      ['UNKNOWN_RULE_SET_POLICY', 'options.ruleSetPolicy', 'downgraded'],
    ])
  })

  it('does not accept proxies or other built-in targets as the policy', () => {
    const r = resolve({ ...p, proxies: [ss('n')] }, [], { ruleSetPolicy: 'n' }, PROXIED)
    expect(r.ruleSetPolicy).toBe('DIRECT')
    expect(resolve(p, [], { ruleSetPolicy: 'REJECT' }, PROXIED).ruleSetPolicy).toBe('DIRECT')
  })

  it('warns when the target cannot download rule sets through a policy', () => {
    const r = resolve(p, [])
    expect(r.ruleSetPolicy).toBeUndefined()
    expect(r.warnings).toEqual([
      {
        level: 'warn',
        path: 'options.ruleSetPolicy',
        code: 'RULE_SET_PROXY_UNSUPPORTED',
        message: expect.stringContaining('mirror'),
        action: 'dropped',
      },
    ])
  })

  it('only notes it when a mirror is in use', () => {
    const r = resolve(p, [], { ruleSetMirror: 'jsdelivr' })
    expect(r.warnings.map((w) => [w.code, w.level])).toEqual([
      ['RULE_SET_MIRROR_UNSUPPORTED', 'info'],
      ['RULE_SET_PROXY_UNSUPPORTED', 'info'],
    ])
  })

  it('does not warn for DIRECT', () => {
    expect(resolve(p, [], { ruleSetPolicy: 'DIRECT' }).warnings).toEqual([])
  })

  it('ignores the option when no rule set is exported', () => {
    const r = resolve({ ...p, ruleSets: [], rules: [] }, [], { ruleSetPolicy: 'Gone' })
    expect(r.warnings).toEqual([])
  })
})

describe('rule sets', () => {
  it('keeps the first of rule sets sharing an id', () => {
    const r = resolve(
      profile({ ruleSets: [set('a'), set('a', 'https://r.example.com/other.list')] }),
      [],
      { ruleSetPolicy: 'DIRECT' },
    )
    expect([...r.ruleSets.values()].map((s) => s.source.url)).toEqual([
      'https://r.example.com/a.list',
    ])
    expect(codes(r.warnings)).toEqual([['DUPLICATE_RULE_SET_ID', 'ruleSets[1]', 'dropped']])
  })
})

describe('rule set mirror', () => {
  const RAW =
    'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Lan/Lan.list'
  const urls = (opts: ExportOptions, url: string) =>
    resolve(profile({ ruleSets: [set('a', url)] }), [], { ruleSetPolicy: 'DIRECT', ...opts })

  it('keeps the original URL by default', () => {
    const r = urls({}, RAW)
    expect([...r.ruleSets.values()].map((s) => s.source.url)).toEqual([RAW])
    expect([...urls({ ruleSetMirror: 'original' }, RAW).ruleSets.values()][0]?.source.url).toBe(RAW)
  })

  it.each([
    [
      RAW,
      'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Surge/Lan/Lan.list',
    ],
    [
      'https://raw.githubusercontent.com/o/r/refs/heads/dev/a/b.list',
      'https://cdn.jsdelivr.net/gh/o/r@dev/a/b.list',
    ],
    [
      'https://raw.githubusercontent.com/o/r/refs/tags/v1.0/b.list',
      'https://cdn.jsdelivr.net/gh/o/r@v1.0/b.list',
    ],
    ['https://github.com/o/r/raw/main/b.list', 'https://cdn.jsdelivr.net/gh/o/r@main/b.list'],
  ])('rewrites %s for jsDelivr', (from, to) => {
    const r = urls({ ruleSetMirror: 'jsdelivr' }, from)
    expect([...r.ruleSets.values()][0]?.source.url).toBe(to)
    expect(r.warnings).toEqual([])
  })

  it('keeps URLs jsDelivr cannot serve and notes it', () => {
    const r = urls({ ruleSetMirror: 'jsdelivr' }, 'https://rules.example.com/a.list')
    expect([...r.ruleSets.values()][0]?.source.url).toBe('https://rules.example.com/a.list')
    expect(codes(r.warnings)).toEqual([['RULE_SET_MIRROR_UNSUPPORTED', 'ruleSets[0]', 'kept']])
  })

  it('prepends a custom prefix to every URL', () => {
    const r = urls({ ruleSetMirror: { prefix: 'https://mirror.example.com/' } }, RAW)
    expect([...r.ruleSets.values()][0]?.source.url).toBe(`https://mirror.example.com/${RAW}`)
    expect(r.warnings).toEqual([])
  })
})
