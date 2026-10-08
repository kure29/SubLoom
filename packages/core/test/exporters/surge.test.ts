import { describe, expect, it } from 'vitest'
import {
  type ExportOptions,
  exportSurge,
  type Profile,
  type ProxyNode,
  type RuleSet,
  surgeExporter,
} from '../../src/index.js'

function profile(p: Partial<Profile> = {}): Profile {
  return { version: 1, name: 'test', proxies: [], groups: [], rules: [], ruleSets: [], ...p }
}

function node(n: Record<string, unknown>): ProxyNode {
  return n as ProxyNode
}

function ss(name: string, over: Record<string, unknown> = {}): ProxyNode {
  return node({
    name,
    type: 'ss',
    server: 's.example.com',
    port: 8388,
    cipher: 'aes-128-gcm',
    password: 'p',
    ...over,
  })
}

const UUID = '0233d11c-15a4-47d3-ade3-48ffca0ce119'

/** 按段拆开输出：段名 → 行 */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of text.split('\n')) {
    const m = /^\[(.+)\]$/.exec(line)
    if (m?.[1]) {
      current = []
      out.set(m[1], current)
    } else if (line && current) {
      current.push(line)
    }
  }
  return out
}

function exp(p: Profile, nodes: ProxyNode[] = [], opts?: ExportOptions) {
  const r = exportSurge(p, nodes, opts)
  return { text: r.text, sec: sections(r.text), warnings: r.warnings }
}

const codes = (warnings: Array<{ code: string; path: string; action: string }>) =>
  warnings.map((w) => [w.code, w.path, w.action])

/** 只导出节点（不含规则），返回 [Proxy] 中的行和警告；忽略缺少 FINAL 的警告 */
function proxies(nodes: ProxyNode[], opts?: ExportOptions) {
  const p = profile({ rules: [{ type: 'MATCH', target: 'DIRECT' }] })
  const { sec, warnings } = exp(p, nodes, opts)
  return { lines: sec.get('Proxy') ?? [], warnings: codes(warnings), sec }
}

function one(n: ProxyNode, opts?: ExportOptions): string {
  const { lines, warnings } = proxies([n], opts)
  expect(warnings).toEqual([])
  expect(lines).toHaveLength(1)
  return lines[0] as string
}

describe('exporter object', () => {
  it('targets surge and declares the capabilities from the manual', () => {
    expect(surgeExporter.target).toBe('surge')
    const caps = surgeExporter.capabilities
    expect(caps.proxyTypes).toEqual([
      'ss',
      'vmess',
      'trojan',
      'hysteria2',
      'tuic',
      'wireguard',
      'anytls',
      'http',
      'socks5',
    ])
    expect(caps.groupTypes).toEqual(['select', 'url-test', 'fallback', 'load-balance'])
    expect(caps.ruleTypes).not.toContain('GEOSITE')
    expect(caps.ruleTypes).not.toContain('DOMAIN-REGEX')
    expect(caps.ruleTypes).toContain('AND')
    expect(caps.logicalRules).toBe(true)
    expect(caps.ruleSetFormats).toEqual(['list', 'text'])
    expect(caps.ruleSetProxy).toBe(false)
    expect(surgeExporter.export(profile(), [])).toEqual(exportSurge(profile(), []))
  })
})

describe('layout', () => {
  it('writes the four sections in order and ends the rules with FINAL', () => {
    const { text, warnings } = exp(profile())
    expect(text).toBe('[General]\n\n[Proxy]\n\n[Proxy Group]\n\n[Rule]\nFINAL,DIRECT\n')
    expect(codes(warnings)).toEqual([['MISSING_FINAL_RULE', 'rules', 'downgraded']])
  })

  it('puts manual proxies before subscription nodes', () => {
    const { lines } = proxies([ss('b')].concat([]), undefined)
    expect(lines).toHaveLength(1)
    const p = profile({ proxies: [ss('a')], rules: [{ type: 'MATCH', target: 'DIRECT' }] })
    expect(
      exp(p, [ss('b')])
        .sec.get('Proxy')
        ?.map((l) => l.split(' = ')[0]),
    ).toEqual(['a', 'b'])
  })
})

describe('proxies', () => {
  it('maps shadowsocks with udp, tfo and obfs', () => {
    expect(one(ss('a', { tfo: true }))).toBe(
      'a = ss, s.example.com, 8388, encrypt-method=aes-128-gcm, password=p, udp-relay=true, tfo=true',
    )
    expect(one(ss('a', { udp: false }))).toBe(
      'a = ss, s.example.com, 8388, encrypt-method=aes-128-gcm, password=p',
    )
    expect(one(ss('a'), { defaultUdp: false })).toBe(
      'a = ss, s.example.com, 8388, encrypt-method=aes-128-gcm, password=p',
    )
    expect(one(ss('a', { plugin: { type: 'obfs', mode: 'tls', host: 'o.example.com' } }))).toBe(
      'a = ss, s.example.com, 8388, encrypt-method=aes-128-gcm, password=p, obfs=tls, obfs-host=o.example.com, udp-relay=true',
    )
  })

  it('drops shadowsocks nodes Surge cannot connect to', () => {
    const { lines, warnings } = proxies([
      ss('v2', { plugin: { type: 'v2ray-plugin', mode: 'websocket' } }),
      ss('cipher', { cipher: '2022-blake3-chacha20-poly1305' }),
      ss('ok', { cipher: '2022-blake3-aes-128-gcm' }),
    ])
    expect(lines.map((l) => l.split(' = ')[0])).toEqual(['ok'])
    expect(warnings).toEqual([
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[0].plugin', 'dropped'],
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[1].cipher', 'dropped'],
    ])
  })

  it('maps vmess over websocket and TLS', () => {
    expect(
      one(
        node({
          name: 'v',
          type: 'vmess',
          server: 'v.example.com',
          port: 443,
          uuid: UUID,
          alterId: 0,
          cipher: 'auto',
          tls: { sni: 's.example.com', skipCertVerify: true },
          transport: { type: 'ws', path: '/ws', host: 'h.example.com', headers: { 'X-A': 'b' } },
        }),
      ),
    ).toBe(
      `v = vmess, v.example.com, 443, username=${UUID}, vmess-aead=true, ws=true, ws-path=/ws, ws-headers=Host:h.example.com|X-A:b, tls=true, sni=s.example.com, skip-cert-verify=true`,
    )
  })

  it('maps vmess ciphers and the legacy handshake', () => {
    const vmess = (cipher: string, alterId = 0) =>
      node({
        name: 'v',
        type: 'vmess',
        server: 'v.example.com',
        port: 80,
        uuid: UUID,
        alterId,
        cipher,
      })
    expect(one(vmess('aes-128-gcm', 64))).toBe(`v = vmess, v.example.com, 80, username=${UUID}`)
    expect(one(vmess('chacha20-poly1305'))).toBe(
      `v = vmess, v.example.com, 80, username=${UUID}, encrypt-method=chacha20-ietf-poly1305, vmess-aead=true`,
    )
    const { lines, warnings } = proxies([vmess('none')])
    expect(lines).toEqual([`v = vmess, v.example.com, 80, username=${UUID}, vmess-aead=true`])
    expect(warnings).toEqual([['UNSUPPORTED_PROXY_FEATURE', 'nodes[0].cipher', 'downgraded']])
  })

  it('drops nodes with unsupported transports and drops early data', () => {
    const trojan = (name: string, transport: unknown) =>
      node({
        name,
        type: 'trojan',
        server: 't.example.com',
        port: 443,
        password: 'p',
        tls: {},
        transport,
      })
    const { lines, warnings } = proxies([
      trojan('grpc', { type: 'grpc', serviceName: 's' }),
      trojan('pipe', { type: 'ws', headers: { 'X-A': 'a|b' } }),
      trojan('ed', { type: 'ws', path: '/', maxEarlyData: 2048, earlyDataHeaderName: 'Sec' }),
    ])
    expect(lines).toEqual(['ed = trojan, t.example.com, 443, password=p, ws=true, ws-path=/'])
    expect(warnings).toEqual([
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[0].transport', 'dropped'],
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[1].transport.headers', 'dropped'],
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[2].transport.maxEarlyData', 'downgraded'],
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[2].transport.earlyDataHeaderName', 'downgraded'],
    ])
  })

  it('maps TLS options and drops what Surge lacks', () => {
    const trojan = (name: string, tls: unknown) =>
      node({ name, type: 'trojan', server: 't.example.com', port: 443, password: 'p', tls })
    const fp = `${'AB:'.repeat(31)}AB`
    expect(
      one(trojan('t', { sni: 's.example.com', alpn: ['h2', 'http/1.1'], certFingerprint: fp })),
    ).toBe(
      `t = trojan, t.example.com, 443, password=p, sni=s.example.com, alpn="h2,http/1.1", server-cert-fingerprint-sha256=${'ab'.repeat(32)}`,
    )
    const { lines, warnings } = proxies([
      trojan('bad-fp', { certFingerprint: 'abcd' }),
      trojan('reality', { reality: { publicKey: 'K' } }),
      trojan('utls', { clientFingerprint: 'chrome', ech: {} }),
    ])
    expect(lines).toEqual(['utls = trojan, t.example.com, 443, password=p'])
    expect(warnings).toEqual([
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[0].tls.certFingerprint', 'dropped'],
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[1].tls.reality', 'dropped'],
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[2].tls.clientFingerprint', 'downgraded'],
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[2].tls.ech', 'downgraded'],
    ])
  })

  it('drops vless and ssr', () => {
    const { lines, warnings } = proxies([
      node({ name: 'l', type: 'vless', server: 'l.example.com', port: 443, uuid: UUID }),
      node({
        name: 'r',
        type: 'ssr',
        server: 'r.example.com',
        port: 443,
        cipher: 'aes-128-cfb',
        password: 'p',
        obfs: 'plain',
        protocol: 'origin',
      }),
    ])
    expect(lines).toEqual([])
    expect(warnings).toEqual([
      ['UNSUPPORTED_PROXY_TYPE', 'nodes[0]', 'dropped'],
      ['UNSUPPORTED_PROXY_TYPE', 'nodes[1]', 'dropped'],
    ])
  })

  it('maps hysteria2', () => {
    const hy = (over: Record<string, unknown>) =>
      node({
        name: 'h',
        type: 'hysteria2',
        server: 'h.example.com',
        port: 443,
        password: 'p',
        tls: { sni: 'h.example.com' },
        ...over,
      })
    expect(one(hy({ ports: '443,20000-30000', down: '100 Mbps' }))).toBe(
      'h = hysteria2, h.example.com, 443, password=p, port-hopping=443;20000-30000, download-bandwidth=100, sni=h.example.com',
    )
    expect(one(hy({ down: '1 Gbps' }))).toContain('download-bandwidth=1000')
    const { lines, warnings } = proxies([
      hy({ up: '50', obfs: { type: 'salamander', password: 'o' } }),
      hy({ password: undefined }),
    ])
    expect(lines).toEqual([
      'h = hysteria2, h.example.com, 443, password=p, salamander-password=o, sni=h.example.com',
    ])
    expect(warnings).toEqual([
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[0].up', 'downgraded'],
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[0].obfs', 'kept'],
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[1].password', 'dropped'],
    ])
  })

  it('notes salamander at info level', () => {
    const r = exportSurge(profile({ rules: [{ type: 'MATCH', target: 'DIRECT' }] }), [
      node({
        name: 'h',
        type: 'hysteria2',
        server: 'h.example.com',
        port: 443,
        password: 'p',
        obfs: { type: 'salamander', password: 'o' },
        tls: {},
      }),
    ])
    expect(r.warnings).toEqual([expect.objectContaining({ level: 'info', action: 'kept' })])
  })

  it('maps tuic as tuic-v5 and anytls', () => {
    const { lines, warnings } = proxies([
      node({
        name: 'u',
        type: 'tuic',
        server: 'u.example.com',
        port: 443,
        uuid: UUID,
        password: 'p',
        congestionController: 'bbr',
        tls: { alpn: ['h3'] },
      }),
      node({
        name: 'a',
        type: 'anytls',
        server: 'a.example.com',
        port: 443,
        password: 'p',
        tls: { sni: 'a.example.com' },
      }),
    ])
    expect(lines).toEqual([
      `u = tuic-v5, u.example.com, 443, uuid=${UUID}, password=p, alpn=h3`,
      'a = anytls, a.example.com, 443, password=p, sni=a.example.com',
    ])
    expect(warnings).toEqual([
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[0].congestionController', 'downgraded'],
    ])
  })

  it('maps http and socks5 with and without TLS', () => {
    const base = { server: 'x.example.com', port: 1080, username: 'u', password: 'p' }
    expect(one(node({ name: 'h', type: 'http', ...base }))).toBe(
      'h = http, x.example.com, 1080, username=u, password=p',
    )
    expect(one(node({ name: 'h', type: 'http', ...base, tls: { sni: 's.example.com' } }))).toBe(
      'h = https, x.example.com, 1080, username=u, password=p, sni=s.example.com',
    )
    expect(one(node({ name: 's', type: 'socks5', ...base }))).toBe(
      's = socks5, x.example.com, 1080, username=u, password=p, udp-relay=true',
    )
    expect(one(node({ name: 's', type: 'socks5', ...base, udp: false, tls: {} }))).toBe(
      's = socks5-tls, x.example.com, 1080, username=u, password=p',
    )
  })

  it('writes WireGuard as a policy line and a section', () => {
    const wg = (name: string, over: Record<string, unknown> = {}) =>
      node({
        name,
        type: 'wireguard',
        server: 'wg.example.com',
        port: 51820,
        privateKey: 'PRIV',
        publicKey: 'PUB',
        preSharedKey: 'PSK',
        ip: '172.16.0.2/32',
        ipv6: 'fd00::2',
        mtu: 1280,
        reserved: [1, 2, 3],
        extra: {
          mihomo: {
            dns: ['1.1.1.1', 'https://dns.example.com/dns-query'],
            'remote-dns-resolve': true,
          },
        },
        ...over,
      })
    const { lines, warnings, sec } = proxies([
      wg('w1'),
      wg('w2', {
        ipv6: undefined,
        preSharedKey: undefined,
        reserved: 'AAAA',
        extra: { mihomo: { dns: ['8.8.8.8'] } },
      }),
      wg('no dns', { extra: undefined }),
    ])
    expect(lines).toEqual(['w1 = wireguard, section-name=wg1', 'w2 = wireguard, section-name=wg2'])
    expect(sec.get('WireGuard wg1')).toEqual([
      'private-key = PRIV',
      'self-ip = 172.16.0.2',
      'self-ip-v6 = fd00::2',
      'dns-server = 1.1.1.1',
      'mtu = 1280',
      'peer = (public-key = PUB, allowed-ips = "0.0.0.0/0, ::/0", endpoint = wg.example.com:51820, preshared-key = PSK, client-id = 1/2/3)',
    ])
    expect(sec.get('WireGuard wg2')).toEqual([
      'private-key = PRIV',
      'self-ip = 172.16.0.2',
      'dns-server = 8.8.8.8',
      'mtu = 1280',
      'peer = (public-key = PUB, allowed-ips = 0.0.0.0/0, endpoint = wg.example.com:51820, client-id = AAAA)',
    ])
    expect(warnings).toEqual([
      ['UNSUPPORTED_PROXY_FEATURE', 'nodes[2].extra.mihomo.dns', 'dropped'],
    ])
  })

  it('appends extra.surge, IR fields first, and warns about other formats', () => {
    const { lines, warnings } = proxies([
      ss('a', {
        extra: {
          surge: {
            'test-url': 'http://t.example.com/',
            password: 'other',
            'ip-version': 'v4-only',
          },
          mihomo: { 'ip-version': 'ipv4' },
        },
      }),
    ])
    expect(lines).toEqual([
      'a = ss, s.example.com, 8388, encrypt-method=aes-128-gcm, password=p, udp-relay=true, test-url=http://t.example.com/, ip-version=v4-only',
    ])
    expect(warnings).toEqual([['EXTRA_IGNORED', 'nodes[0].extra.mihomo', 'dropped']])
  })

  it('quotes values with commas, quotes, surrounding spaces or comment markers', () => {
    const pw = (password: string) => one(ss('a', { password, udp: false })).split('password=')[1]
    expect(pw('a,b')).toBe('"a,b"')
    expect(pw('a"b')).toBe('"a\\"b"')
    expect(pw('a\\b')).toBe('a\\b')
    expect(pw('a\\,b')).toBe('"a\\\\,b"')
    expect(pw(' a')).toBe('" a"')
    expect(pw('a #b')).toBe('"a #b"')
    expect(pw('a //b')).toBe('"a //b"')
    expect(pw('a ;b')).toBe('"a ;b"')
    expect(pw('a#b')).toBe('a#b')
  })
})

describe('names', () => {
  it('replaces characters Surge cannot use in policy names and keeps references', () => {
    const { sec, warnings } = exp(
      profile({
        groups: [{ name: 'G=1', type: 'select', members: [{ kind: 'proxy', name: 'HK,01 #2' }] }],
        rules: [
          { type: 'DOMAIN', value: 'a.example.com', target: 'HK,01 #2' },
          { type: 'MATCH', target: 'G=1' },
        ],
      }),
      [ss('HK,01 #2', { udp: false }), ss('a //b ;c', { udp: false })],
    )
    expect(sec.get('Proxy')?.map((l) => l.split(' = ')[0])).toEqual(['HK，01 ＃2', 'a ／／b ；c'])
    expect(sec.get('Proxy Group')).toEqual(['G＝1 = select, HK，01 ＃2'])
    expect(sec.get('Rule')).toEqual(['DOMAIN,a.example.com,HK，01 ＃2', 'FINAL,G＝1'])
    expect(codes(warnings)).toEqual([
      ['INVALID_NAME_CHARS', 'groups[0].name', 'kept'],
      ['INVALID_NAME_CHARS', 'nodes[0].name', 'kept'],
      ['INVALID_NAME_CHARS', 'nodes[1].name', 'kept'],
    ])
  })

  it('renames duplicates like the mihomo exporter', () => {
    const { sec } = exp(profile({ rules: [{ type: 'MATCH', target: 'DIRECT' }] }), [
      ss('a', { udp: false }),
      ss('a', { udp: false }),
      ss('REJECT-TINYGIF', { udp: false }),
    ])
    expect(sec.get('Proxy')?.map((l) => l.split(' = ')[0])).toEqual([
      'a',
      'a 2',
      'REJECT-TINYGIF 2',
    ])
  })
})

describe('groups', () => {
  const DIRECT = { kind: 'builtin', name: 'DIRECT' } as const

  it('maps every field', () => {
    const { sec, warnings } = exp(
      profile({
        groups: [
          {
            name: 'Auto',
            type: 'url-test',
            members: [DIRECT],
            includeAllProxies: true,
            filter: { include: '(?i)hk' },
            testUrl: 'https://cp.example.com/generate_204',
            interval: 300,
            tolerance: 50,
            hidden: true,
            icon: 'https://icon.example.com/a.png',
            extra: { surge: { 'evaluate-before-use': true } },
          },
          {
            name: 'LB',
            type: 'load-balance',
            members: [{ kind: 'group', name: 'Auto' }],
            interval: 600,
          },
          { name: 'FB', type: 'fallback', members: [{ kind: 'group', name: 'Auto' }, DIRECT] },
        ],
        rules: [{ type: 'MATCH', target: 'Auto' }],
      }),
    )
    expect(sec.get('Proxy Group')).toEqual([
      'Auto = url-test, DIRECT, include-all-proxies=true, policy-regex-filter=(?i)hk, interval=300, tolerance=50, hidden=true, icon-url=https://icon.example.com/a.png, evaluate-before-use=true',
      'LB = load-balance, Auto, interval=600',
      'FB = fallback, Auto, DIRECT',
    ])
    expect(sec.get('General')).toEqual(['proxy-test-url = https://cp.example.com/generate_204'])
    expect(warnings).toEqual([])
  })

  it('merges exclude filters into one regex and notes it', () => {
    const group = (filter: { include?: string; exclude?: string }) => ({
      name: 'G',
      type: 'select' as const,
      members: [],
      includeAllProxies: true,
      filter,
    })
    const filterOf = (f: { include?: string; exclude?: string }) => {
      const r = exp(profile({ groups: [group(f)], rules: [{ type: 'MATCH', target: 'G' }] }))
      return { line: r.sec.get('Proxy Group')?.[0], warnings: r.warnings }
    }
    expect(filterOf({ include: 'HK|JP', exclude: 'x' }).line).toBe(
      'G = select, include-all-proxies=true, policy-regex-filter=^(?=.*(?:HK|JP))(?!.*(?:x))',
    )
    expect(filterOf({ include: '(?i)hk', exclude: '(?i)iplc' }).line).toBe(
      'G = select, include-all-proxies=true, policy-regex-filter=^(?=.*(?i:hk))(?!.*(?i:iplc))',
    )
    const { line, warnings } = filterOf({ exclude: 'a{1,2}' })
    expect(line).toBe(
      'G = select, include-all-proxies=true, policy-regex-filter="^(?!.*(?:a{1,2}))"',
    )
    expect(warnings).toEqual([
      expect.objectContaining({
        level: 'info',
        code: 'GROUP_FILTER_REWRITTEN',
        path: 'groups[0].filter',
        action: 'kept',
      }),
    ])
  })

  it('writes one global test URL and warns about the others', () => {
    const url = (u: string) => `https://${u}.example.com/generate_204`
    const groups: Profile['groups'] = [
      { name: 'A', type: 'url-test', members: [DIRECT], testUrl: url('a') },
      { name: 'B', type: 'url-test', members: [DIRECT], testUrl: url('b') },
      { name: 'C', type: 'url-test', members: [DIRECT], testUrl: url('a') },
    ]
    const rules: Profile['rules'] = [{ type: 'MATCH', target: 'A' }]
    const first = exp(profile({ groups, rules }))
    expect(first.sec.get('General')).toEqual([`proxy-test-url = ${url('a')}`])
    expect(codes(first.warnings)).toEqual([
      ['UNSUPPORTED_GROUP_OPTION', 'groups[1].testUrl', 'downgraded'],
    ])

    const explicit = exp(
      profile({ groups, rules, general: { extra: { surge: { 'proxy-test-url': url('b') } } } }),
    )
    expect(explicit.sec.get('General')).toEqual([`proxy-test-url = ${url('b')}`])
    expect(codes(explicit.warnings)).toEqual([
      ['UNSUPPORTED_GROUP_OPTION', 'groups[0].testUrl', 'downgraded'],
      ['UNSUPPORTED_GROUP_OPTION', 'groups[2].testUrl', 'downgraded'],
    ])
  })

  it('drops interval and tolerance where Surge does not use them', () => {
    const { sec, warnings } = exp(
      profile({
        groups: [
          { name: 'S', type: 'select', members: [DIRECT], interval: 300 },
          { name: 'F', type: 'fallback', members: [DIRECT], interval: 300, tolerance: 50 },
        ],
        rules: [{ type: 'MATCH', target: 'S' }],
      }),
    )
    expect(sec.get('Proxy Group')).toEqual([
      'S = select, DIRECT',
      'F = fallback, DIRECT, interval=300',
    ])
    expect(codes(warnings)).toEqual([
      ['UNSUPPORTED_GROUP_OPTION', 'groups[0].interval', 'dropped'],
      ['UNSUPPORTED_GROUP_OPTION', 'groups[1].tolerance', 'dropped'],
    ])
  })

  it('cleans up members like the mihomo exporter', () => {
    const { sec, warnings } = exp(
      profile({
        groups: [
          { name: 'A', type: 'select', members: [{ kind: 'proxy', name: 'gone' }] },
          { name: 'A', type: 'select', members: [DIRECT] },
        ],
        rules: [{ type: 'MATCH', target: 'A' }],
      }),
    )
    expect(sec.get('Proxy Group')).toEqual(['A = select, DIRECT'])
    expect(codes(warnings)).toEqual([
      ['DUPLICATE_GROUP_NAME', 'groups[1]', 'dropped'],
      ['UNKNOWN_GROUP_MEMBER', 'groups[0].members[0]', 'dropped'],
      ['EMPTY_GROUP', 'groups[0]', 'downgraded'],
    ])
  })
})

describe('rules', () => {
  const groups: Profile['groups'] = [
    { name: 'G', type: 'select', members: [{ kind: 'builtin', name: 'DIRECT' }] },
  ]
  const rules = (list: Profile['rules'], opts?: ExportOptions, ruleSets: RuleSet[] = []) => {
    const r = exp(profile({ groups, rules: list, ruleSets }), [], opts)
    return { lines: r.sec.get('Rule'), warnings: codes(r.warnings) }
  }

  it('maps rule types and parameters', () => {
    expect(
      rules([
        { type: 'DOMAIN-SUFFIX', value: 'a.example.com', target: 'G' },
        { type: 'DOMAIN', value: 'b.example.com', noResolve: true, target: 'G' },
        { type: 'DOMAIN-KEYWORD', value: 'a,b', target: 'G' },
        { type: 'IP-CIDR', value: '10.0.0.0/8', noResolve: true, target: 'DIRECT' },
        { type: 'IP-CIDR6', value: 'fc00::/7', target: 'DIRECT' },
        { type: 'GEOIP', value: 'CN', target: 'DIRECT' },
        { type: 'IP-ASN', value: '13335', noResolve: true, target: 'G' },
        { type: 'PROCESS-NAME', value: 'Telegram', target: 'G' },
        { type: 'DST-PORT', value: '22', target: 'DIRECT' },
        { type: 'SRC-IP-CIDR', value: '192.168.1.0/24', target: 'DIRECT' },
        { type: 'IP-CIDR', value: '192.168.2.0/24', src: true, noResolve: true, target: 'REJECT' },
        {
          type: 'AND',
          children: [
            { type: 'DOMAIN', value: 'c.example.com' },
            { type: 'NOT', children: [{ type: 'DST-PORT', value: '443' }] },
          ],
          target: 'G',
        },
        { type: 'MATCH', target: 'G' },
      ]),
    ).toEqual({
      lines: [
        'DOMAIN-SUFFIX,a.example.com,G',
        'DOMAIN,b.example.com,G',
        'DOMAIN-KEYWORD,"a,b",G',
        'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
        'IP-CIDR6,fc00::/7,DIRECT',
        'GEOIP,CN,DIRECT',
        'IP-ASN,13335,G,no-resolve',
        'PROCESS-NAME,Telegram,G',
        'DEST-PORT,22,DIRECT',
        'SRC-IP,192.168.1.0/24,DIRECT',
        'SRC-IP,192.168.2.0/24,REJECT',
        'AND,((DOMAIN,c.example.com),(NOT,((DEST-PORT,443)))),G',
        'FINAL,G',
      ],
      warnings: [],
    })
  })

  it('drops rules Surge cannot express', () => {
    expect(
      rules([
        { type: 'GEOSITE', value: 'google', target: 'G' },
        { type: 'DOMAIN-REGEX', value: '^a', target: 'G' },
        { type: 'GEOIP', value: 'CN', src: true, target: 'G' },
        { type: 'OR', children: [{ type: 'GEOSITE', value: 'cn' }], target: 'G' },
        { type: 'MATCH', target: 'G' },
      ]),
    ).toEqual({
      lines: ['FINAL,G'],
      warnings: [
        ['UNSUPPORTED_RULE_TYPE', 'rules[0]', 'dropped'],
        ['UNSUPPORTED_RULE_TYPE', 'rules[1]', 'dropped'],
        ['UNSUPPORTED_RULE_PARAM', 'rules[2]', 'dropped'],
        ['UNSUPPORTED_RULE_TYPE', 'rules[3]', 'dropped'],
      ],
    })
  })

  it('stops at the first MATCH and adds FINAL,DIRECT when there is none', () => {
    expect(
      rules([
        { type: 'MATCH', target: 'G' },
        { type: 'DOMAIN', value: 'a.example.com', target: 'G' },
        { type: 'MATCH', target: 'DIRECT' },
      ]),
    ).toEqual({
      lines: ['FINAL,G'],
      warnings: [
        ['UNREACHABLE_RULE', 'rules[1]', 'dropped'],
        ['UNREACHABLE_RULE', 'rules[2]', 'dropped'],
      ],
    })
    expect(
      rules([
        { type: 'DOMAIN', value: 'a.example.com', target: 'G' },
        { type: 'MATCH', target: 'gone' },
      ]),
    ).toEqual({
      lines: ['DOMAIN,a.example.com,G', 'FINAL,DIRECT'],
      warnings: [
        ['UNKNOWN_RULE_TARGET', 'rules[1]', 'dropped'],
        ['MISSING_FINAL_RULE', 'rules', 'downgraded'],
      ],
    })
  })

  it('writes rule sets as RULE-SET and DOMAIN-SET lines with their URLs', () => {
    const set = (id: string, behavior: RuleSet['behavior'], format: string, interval?: number) =>
      ({
        id,
        name: id,
        behavior,
        sources: { surge: { url: `https://r.example.com/${id}`, format } },
        ...(interval && { interval }),
      }) as RuleSet
    const sets = [
      set('list', 'classical', 'list', 86400),
      set('domains', 'domain', 'text'),
      set('ips', 'ipcidr', 'text'),
      set('yaml', 'domain', 'yaml'),
      {
        id: 'mihomo-only',
        name: 'm',
        behavior: 'domain',
        sources: { mihomo: { url: 'https://r.example.com/m', format: 'yaml' } },
      } as RuleSet,
    ]
    expect(
      rules(
        [
          { type: 'RULE-SET', value: 'list', noResolve: true, target: 'G' },
          { type: 'RULE-SET', value: 'domains', target: 'REJECT' },
          { type: 'RULE-SET', value: 'ips', target: 'G' },
          {
            type: 'AND',
            children: [
              { type: 'RULE-SET', value: 'list' },
              { type: 'DST-PORT', value: '443' },
            ],
            target: 'G',
          },
          { type: 'RULE-SET', value: 'list', src: true, target: 'G' },
          { type: 'MATCH', target: 'G' },
        ],
        { ruleSetPolicy: 'DIRECT' },
        sets,
      ),
    ).toEqual({
      lines: [
        'RULE-SET,https://r.example.com/list,G,no-resolve,update-interval=86400',
        'DOMAIN-SET,https://r.example.com/domains,REJECT',
        'AND,((RULE-SET,https://r.example.com/list),(DEST-PORT,443)),G',
        'FINAL,G',
      ],
      warnings: [
        ['UNSUPPORTED_RULE_SET_FORMAT', 'ruleSets[2]', 'dropped'],
        ['UNSUPPORTED_RULE_SET_FORMAT', 'ruleSets[3]', 'dropped'],
        ['RULE_SET_NO_SOURCE', 'ruleSets[4]', 'dropped'],
        ['UNKNOWN_RULE_SET', 'rules[2]', 'dropped'],
        ['UNSUPPORTED_RULE_PARAM', 'rules[4]', 'dropped'],
      ],
    })
  })

  it('warns that Surge cannot download rule sets through a group, and applies the mirror', () => {
    const sets = [
      {
        id: 'a',
        name: 'a',
        behavior: 'classical',
        sources: {
          surge: { url: 'https://raw.githubusercontent.com/o/r/master/a.list', format: 'list' },
        },
      } as RuleSet,
    ]
    const list: Profile['rules'] = [
      { type: 'RULE-SET', value: 'a', target: 'G' },
      { type: 'MATCH', target: 'G' },
    ]
    expect(rules(list, {}, sets).warnings).toEqual([
      ['RULE_SET_PROXY_UNSUPPORTED', 'options.ruleSetPolicy', 'dropped'],
    ])
    expect(rules(list, { ruleSetMirror: 'jsdelivr', ruleSetPolicy: 'DIRECT' }, sets)).toEqual({
      lines: ['RULE-SET,https://cdn.jsdelivr.net/gh/o/r@master/a.list,G', 'FINAL,G'],
      warnings: [],
    })
  })
})

describe('general and dns', () => {
  const MATCH: Profile['rules'] = [{ type: 'MATCH', target: 'DIRECT' }]

  it('maps the basic settings and drops the rest with warnings', () => {
    const { sec, warnings } = exp(
      profile({
        general: {
          mixedPort: 7890,
          allowLan: true,
          mode: 'rule',
          logLevel: 'debug',
          ipv6: true,
          extra: {
            surge: {
              'skip-proxy': '192.168.0.0/16, localhost',
              'test-timeout': 5,
              'always-real-ip': ['*.lan', 'stun.*'],
            },
            mihomo: { 'unified-delay': true },
          },
        },
        dns: {
          enable: true,
          ipv6: false,
          enhancedMode: 'fake-ip',
          fakeIpRange: '198.18.0.1/16',
          defaultNameserver: ['223.5.5.5', '119.29.29.29'],
          nameserver: [
            '223.5.5.5',
            'udp://1.1.1.1:53',
            '2001:4860:4860::8888',
            'tcp://8.8.8.8',
            'system',
            'https://dns.alidns.com/dns-query',
            'tls://1.1.1.1',
            'quic://dns.adguard.com',
            'h3://dns.example.com/dns-query',
            'dhcp://en0',
            'dns.example.com',
            'https://doh.example.com/dns-query#PROXY',
          ],
          fallback: ['tls://8.8.4.4'],
        },
        rules: MATCH,
      }),
    )
    expect(sec.get('General')).toEqual([
      'loglevel = verbose',
      'ipv6 = true',
      'dns-server = 223.5.5.5, 1.1.1.1:53, 2001:4860:4860::8888, tcp://8.8.8.8, system, 119.29.29.29',
      'encrypted-dns-server = https://dns.alidns.com/dns-query, tls://1.1.1.1, quic://dns.adguard.com, h3://dns.example.com/dns-query',
      'skip-proxy = 192.168.0.0/16, localhost',
      'test-timeout = 5',
      'always-real-ip = *.lan, stun.*',
    ])
    expect(codes(warnings)).toEqual([
      ['UNSUPPORTED_SETTING', 'general.mixedPort', 'dropped'],
      ['UNSUPPORTED_SETTING', 'general.allowLan', 'dropped'],
      ['UNSUPPORTED_SETTING', 'general.mode', 'dropped'],
      ['EXTRA_IGNORED', 'general.extra.mihomo', 'dropped'],
      ['UNSUPPORTED_SETTING', 'dns.enable', 'dropped'],
      ['UNSUPPORTED_SETTING', 'dns.ipv6', 'dropped'],
      ['UNSUPPORTED_SETTING', 'dns.enhancedMode', 'dropped'],
      ['UNSUPPORTED_SETTING', 'dns.fakeIpRange', 'dropped'],
      ['UNSUPPORTED_SETTING', 'dns.fallback', 'dropped'],
      ['UNSUPPORTED_DNS_SERVER', 'dns.nameserver[9]', 'dropped'],
      ['UNSUPPORTED_DNS_SERVER', 'dns.nameserver[10]', 'dropped'],
      ['UNSUPPORTED_DNS_SERVER', 'dns.nameserver[11]', 'dropped'],
    ])
  })

  it.each([
    ['debug', 'verbose'],
    ['info', 'info'],
    ['warning', 'warning'],
    ['error', 'warning'],
  ] as const)('maps log level %s to %s', (from, to) => {
    const { sec, warnings } = exp(profile({ general: { logLevel: from }, rules: MATCH }))
    expect(sec.get('General')).toEqual([`loglevel = ${to}`])
    expect(warnings).toEqual([])
  })

  it('downgrades the silent log level', () => {
    const { sec, warnings } = exp(profile({ general: { logLevel: 'silent' }, rules: MATCH }))
    expect(sec.get('General')).toEqual(['loglevel = warning'])
    expect(codes(warnings)).toEqual([['UNSUPPORTED_SETTING', 'general.logLevel', 'downgraded']])
  })

  it('takes ipv6 from dns when general does not set it', () => {
    const { sec, warnings } = exp(profile({ dns: { ipv6: false }, rules: MATCH }))
    expect(sec.get('General')).toEqual(['ipv6 = false'])
    expect(warnings).toEqual([])
  })

  it('appends extra sections from profile.extra.surge', () => {
    const { text, warnings } = exp(
      profile({
        rules: MATCH,
        extra: {
          surge: {
            MITM: ['hostname = a.example.com'],
            Host: [
              'a.example.com = 1.2.3.4',
              'b.example.com = server:https://dns.example.com/dns-query',
            ],
            Rule: ['DOMAIN,x.example.com,DIRECT'],
            Bad: 'not a list',
          },
        },
      }),
    )
    expect(
      text.endsWith(
        '[Rule]\nFINAL,DIRECT\n\n[MITM]\nhostname = a.example.com\n\n[Host]\na.example.com = 1.2.3.4\nb.example.com = server:https://dns.example.com/dns-query\n',
      ),
    ).toBe(true)
    expect(codes(warnings)).toEqual([
      ['EXTRA_IGNORED', 'extra.surge.Rule', 'dropped'],
      ['EXTRA_IGNORED', 'extra.surge.Bad', 'dropped'],
    ])
  })
})
