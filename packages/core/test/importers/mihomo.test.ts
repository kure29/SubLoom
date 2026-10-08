import { describe, expect, it } from 'vitest'
import {
  type ImportResult,
  importMihomoYaml,
  ProfileSchema,
  type ProxyNode,
} from '../../src/index.js'

/** 测试中直接访问各协议的字段 */
type AnyProxy = ProxyNode & Record<string, unknown>

function imp(yaml: string): ImportResult {
  const r = importMihomoYaml(yaml)
  expect(r.format).toBe('mihomo-yaml')
  return r
}

/** 只含一个节点的 YAML，返回该节点 */
function one(proxyYaml: string): AnyProxy {
  const r = imp(`proxies:\n  - ${proxyYaml}\n`)
  expect(r.warnings).toEqual([])
  const [p] = r.proxies
  if (!p || r.proxies.length !== 1) throw new Error('expected exactly one proxy')
  return p
}

describe('proxies', () => {
  it('maps ss with udp/tfo, keeps udp: false and drops other false booleans', () => {
    expect(
      one(
        '{ name: s, type: ss, server: s.example.com, port: "8388", cipher: aes-128-gcm, password: p, udp: false, tfo: true }',
      ),
    ).toEqual({
      name: 's',
      type: 'ss',
      server: 's.example.com',
      port: 8388,
      udp: false,
      tfo: true,
      cipher: 'aes-128-gcm',
      password: 'p',
    })
  })

  it('records the mihomo UDP default when udp is missing', () => {
    const base = 'server: x.example.com, port: 443, password: p'
    expect(one(`{ name: s, type: trojan, ${base} }`).udp).toBe(false)
    // mihomo 对 hysteria2、tuic 总是开启 UDP
    expect(one(`{ name: h, type: hysteria2, ${base} }`).udp).toBe(true)
    expect(one(`{ name: t, type: tuic, ${base}, uuid: u }`).udp).toBe(true)
    // 显式写出的值原样保留
    expect(one(`{ name: h, type: hysteria2, ${base}, udp: false }`).udp).toBe(false)
    expect(one(`{ name: s, type: trojan, ${base}, udp: true }`).udp).toBe(true)
  })

  it('converts numeric names to strings', () => {
    expect(
      one('{ name: 123, type: ss, server: s.example.com, port: 1, cipher: a, password: p }').name,
    ).toBe('123')
  })

  it('maps the ss v2ray-plugin and keeps unknown plugin options in extra', () => {
    expect(
      one(
        '{ name: s, type: ss, server: s.example.com, port: 443, cipher: a, password: p, plugin: v2ray-plugin, plugin-opts: { mode: websocket, host: h.example.com, path: /ws, tls: true, mux: true, skip-cert-verify: true, headers: { X-A: b }, v2ray-http-upgrade: true } }',
      ),
    ).toMatchObject({
      plugin: {
        type: 'v2ray-plugin',
        mode: 'websocket',
        host: 'h.example.com',
        path: '/ws',
        tls: true,
        mux: true,
        skipCertVerify: true,
        headers: { 'X-A': 'b' },
      },
      extra: { mihomo: { 'plugin-opts': { 'v2ray-http-upgrade': true } } },
    })
  })

  it('keeps unsupported ss plugins entirely in extra', () => {
    const p = one(
      '{ name: s, type: ss, server: s.example.com, port: 443, cipher: a, password: p, plugin: shadow-tls, plugin-opts: { host: h.example.com, password: x, version: 3 } }',
    )
    expect(p).not.toHaveProperty('plugin')
    expect(p.extra).toEqual({
      mihomo: {
        plugin: 'shadow-tls',
        'plugin-opts': { host: 'h.example.com', password: 'x', version: 3 },
      },
    })
  })

  it('maps ssr', () => {
    expect(
      one(
        '{ name: r, type: ssr, server: r.example.com, port: 443, cipher: aes-256-cfb, password: p, obfs: tls1.2_ticket_auth, obfs-param: o.example.com, protocol: auth_aes128_md5, protocol-param: "1:x" }',
      ),
    ).toEqual({
      name: 'r',
      type: 'ssr',
      server: 'r.example.com',
      port: 443,
      udp: false,
      cipher: 'aes-256-cfb',
      password: 'p',
      obfs: 'tls1.2_ticket_auth',
      obfsParam: 'o.example.com',
      protocol: 'auth_aes128_md5',
      protocolParam: '1:x',
    })
  })

  it('maps vmess h2 and http transports', () => {
    expect(
      one(
        '{ name: v, type: vmess, server: v.example.com, port: 443, uuid: u, alterId: 0, cipher: auto, tls: true, network: h2, h2-opts: { host: [a.example.com], path: /h2 } }',
      ),
    ).toMatchObject({ tls: {}, transport: { type: 'h2', host: ['a.example.com'], path: '/h2' } })
    expect(
      one(
        '{ name: v, type: vmess, server: v.example.com, port: 80, uuid: u, alterId: 0, cipher: auto, network: http, http-opts: { method: GET, path: [/a, /b], headers: { Host: [a.example.com], Connection: [keep-alive] } } }',
      ).transport,
    ).toEqual({
      type: 'http',
      method: 'GET',
      path: ['/a', '/b'],
      host: ['a.example.com'],
      headers: { Connection: ['keep-alive'] },
    })
  })

  it('fills vmess defaults when alterId and cipher are missing', () => {
    expect(
      one('{ name: v, type: vmess, server: v.example.com, port: 443, uuid: u }'),
    ).toMatchObject({
      alterId: 0,
      cipher: 'auto',
    })
  })

  it('maps ws early data, httpupgrade and keeps unknown ws options in extra', () => {
    expect(
      one(
        '{ name: v, type: vless, server: v.example.com, port: 443, uuid: u, network: ws, ws-opts: { path: /ws, headers: { Host: h.example.com, User-Agent: ua }, max-early-data: 2048, early-data-header-name: Sec-WebSocket-Protocol, v2ray-http-upgrade-fast-open: true } }',
      ),
    ).toMatchObject({
      transport: {
        type: 'ws',
        path: '/ws',
        host: 'h.example.com',
        headers: { 'User-Agent': 'ua' },
        maxEarlyData: 2048,
        earlyDataHeaderName: 'Sec-WebSocket-Protocol',
      },
      extra: { mihomo: { 'ws-opts': { 'v2ray-http-upgrade-fast-open': true } } },
    })
    expect(
      one(
        '{ name: v, type: vless, server: v.example.com, port: 443, uuid: u, network: ws, ws-opts: { path: /up, v2ray-http-upgrade: true } }',
      ).transport,
    ).toEqual({ type: 'httpupgrade', path: '/up' })
  })

  it('maps vless reality over grpc', () => {
    expect(
      one(
        '{ name: v, type: vless, server: v.example.com, port: 443, uuid: u, tls: true, servername: s.example.com, network: grpc, grpc-opts: { grpc-service-name: svc }, reality-opts: { public-key: K, short-id: "01" }, client-fingerprint: chrome }',
      ),
    ).toEqual({
      name: 'v',
      type: 'vless',
      server: 'v.example.com',
      port: 443,
      udp: false,
      uuid: 'u',
      tls: {
        sni: 's.example.com',
        clientFingerprint: 'chrome',
        reality: { publicKey: 'K', shortId: '01' },
      },
      transport: { type: 'grpc', serviceName: 'svc' },
    })
  })

  it('keeps TLS-only fields in extra when TLS is off', () => {
    expect(
      one(
        '{ name: v, type: vmess, server: v.example.com, port: 80, uuid: u, alterId: 0, cipher: auto, servername: s.example.com }',
      ).extra,
    ).toEqual({ mihomo: { servername: 's.example.com' } })
  })

  it('maps trojan TLS options', () => {
    expect(
      one(
        '{ name: t, type: trojan, server: t.example.com, port: 443, password: p, sni: s.example.com, alpn: [h2], skip-cert-verify: true, client-fingerprint: ios, fingerprint: AB, ech-opts: { enable: true, config: Q0ZH } }',
      ),
    ).toMatchObject({
      tls: {
        sni: 's.example.com',
        alpn: ['h2'],
        skipCertVerify: true,
        clientFingerprint: 'ios',
        certFingerprint: 'AB',
        ech: { config: 'Q0ZH' },
      },
    })
  })

  it('maps hysteria2 with port hopping and bandwidth', () => {
    expect(
      one(
        '{ name: h, type: hysteria2, server: h.example.com, port: 443, ports: "443,20000-30000", password: p, up: 50, down: "200 Mbps", obfs: salamander, obfs-password: o, sni: s.example.com }',
      ),
    ).toEqual({
      name: 'h',
      type: 'hysteria2',
      server: 'h.example.com',
      port: 443,
      udp: true,
      password: 'p',
      ports: '443,20000-30000',
      obfs: { type: 'salamander', password: 'o' },
      up: '50',
      down: '200 Mbps',
      tls: { sni: 's.example.com' },
    })
  })

  it('maps tuic v5', () => {
    expect(
      one(
        '{ name: t, type: tuic, server: t.example.com, port: 443, uuid: u, password: p, sni: s.example.com, alpn: [h3], congestion-controller: bbr, udp-relay-mode: quic, reduce-rtt: true, heartbeat-interval: 10000 }',
      ),
    ).toEqual({
      name: 't',
      type: 'tuic',
      server: 't.example.com',
      port: 443,
      udp: true,
      uuid: 'u',
      password: 'p',
      congestionController: 'bbr',
      udpRelayMode: 'quic',
      reduceRtt: true,
      tls: { sni: 's.example.com', alpn: ['h3'] },
      extra: { mihomo: { 'heartbeat-interval': 10000 } },
    })
  })

  it('maps wireguard', () => {
    expect(
      one(
        '{ name: w, type: wireguard, server: 198.51.100.1, port: 51820, ip: 10.0.0.2, ipv6: "fd00::2", private-key: PRIV, public-key: PUB, pre-shared-key: PSK, reserved: [1, 2, 3], mtu: 1280, udp: true, allowed-ips: ["0.0.0.0/0"] }',
      ),
    ).toEqual({
      name: 'w',
      type: 'wireguard',
      server: '198.51.100.1',
      port: 51820,
      udp: true,
      privateKey: 'PRIV',
      publicKey: 'PUB',
      preSharedKey: 'PSK',
      ip: '10.0.0.2',
      ipv6: 'fd00::2',
      reserved: [1, 2, 3],
      mtu: 1280,
      extra: { mihomo: { 'allowed-ips': ['0.0.0.0/0'] } },
    })
  })

  it('maps anytls, http and socks5', () => {
    expect(
      one(
        '{ name: a, type: anytls, server: a.example.com, port: 443, password: p, idle-session-timeout: 30 }',
      ),
    ).toEqual({
      name: 'a',
      type: 'anytls',
      server: 'a.example.com',
      port: 443,
      udp: false,
      password: 'p',
      tls: {},
      extra: { mihomo: { 'idle-session-timeout': 30 } },
    })
    expect(
      one(
        '{ name: h, type: http, server: h.example.com, port: 443, username: u, password: p, tls: true, sni: s.example.com }',
      ),
    ).toEqual({
      name: 'h',
      type: 'http',
      server: 'h.example.com',
      port: 443,
      udp: false,
      username: 'u',
      password: 'p',
      tls: { sni: 's.example.com' },
    })
    expect(one('{ name: s, type: socks5, server: s.example.com, port: 1080, udp: true }')).toEqual({
      name: 's',
      type: 'socks5',
      server: 's.example.com',
      port: 1080,
      udp: true,
    })
  })

  it('keeps unknown top-level proxy fields in extra', () => {
    expect(
      one(
        '{ name: s, type: ss, server: s.example.com, port: 1, cipher: a, password: p, ip-version: ipv4, dialer-proxy: other, smux: { enabled: true } }',
      ).extra,
    ).toEqual({
      mihomo: { 'ip-version': 'ipv4', 'dialer-proxy': 'other', smux: { enabled: true } },
    })
  })

  it('skips invalid and unsupported proxies with path-based warnings', () => {
    const r = imp(`proxies:
  - { name: ok, type: ss, server: s.example.com, port: 1, cipher: a, password: p }
  - { name: no-server, type: ss, port: 1, cipher: a, password: p }
  - { name: snell, type: snell, server: s.example.com, port: 1, psk: x }
  - { name: kcp, type: vmess, server: v.example.com, port: 1, uuid: u, network: kcp }
  - { name: bad-port, type: trojan, server: t.example.com, port: 99999, password: p }
  - just a string
`)
    expect(r.proxies.map((p) => p.name)).toEqual(['ok'])
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: 'INVALID_PROXY', path: 'proxies[1]', protocol: 'ss' }),
      expect.objectContaining({
        code: 'UNSUPPORTED_PROTOCOL',
        path: 'proxies[2]',
        protocol: 'snell',
      }),
      expect.objectContaining({
        code: 'UNSUPPORTED_TRANSPORT',
        path: 'proxies[3]',
        protocol: 'vmess',
      }),
      expect.objectContaining({ code: 'INVALID_PROXY', path: 'proxies[4]', protocol: 'trojan' }),
      expect.objectContaining({ code: 'INVALID_PROXY', path: 'proxies[5]' }),
    ])
    for (const w of r.warnings) expect(w.message).not.toMatch(/example\.com/)
  })
})

describe('proxy groups', () => {
  it('maps group fields, resolves members and keeps unknown fields in extra', () => {
    const r = imp(`proxies:
  - { name: n1, type: ss, server: s.example.com, port: 1, cipher: a, password: p }
proxy-groups:
  - { name: lb, type: load-balance, proxies: [n1, later, REJECT-DROP, missing], strategy: round-robin, url: "https://t.example.com", interval: 60, lazy: true }
  - { name: later, type: select, include-all-proxies: true, filter: "a", exclude-filter: "b", hidden: true, icon: "https://i.example.com/x.png", use: [provider1] }
  - { name: chain, type: relay, proxies: [n1] }
`)
    const config = r.config
    if (!config) throw new Error('config missing')
    expect(config.groups).toEqual([
      {
        name: 'lb',
        type: 'load-balance',
        members: [
          { kind: 'proxy', name: 'n1' },
          { kind: 'group', name: 'later' },
          { kind: 'builtin', name: 'REJECT-DROP' },
          { kind: 'proxy', name: 'missing' },
        ],
        testUrl: 'https://t.example.com',
        interval: 60,
        extra: { mihomo: { strategy: 'round-robin', lazy: true } },
      },
      {
        name: 'later',
        type: 'select',
        members: [],
        includeAllProxies: true,
        filter: { include: 'a', exclude: 'b' },
        hidden: true,
        icon: 'https://i.example.com/x.png',
        extra: { mihomo: { use: ['provider1'] } },
      },
    ])
    expect(r.warnings).toEqual([
      expect.objectContaining({
        level: 'info',
        code: 'UNKNOWN_GROUP_MEMBER',
        path: 'proxy-groups[0].proxies[3]',
      }),
      expect.objectContaining({
        level: 'warn',
        code: 'UNSUPPORTED_GROUP_TYPE',
        path: 'proxy-groups[2]',
      }),
    ])
  })

  it('skips groups without a name or with a bad type', () => {
    const r = imp(
      'proxies: []\nproxy-groups:\n  - { type: select, proxies: [DIRECT] }\n  - { name: x, proxies: [DIRECT] }\n',
    )
    expect(r.config?.groups).toEqual([])
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([
      ['INVALID_GROUP', 'proxy-groups[0]'],
      ['INVALID_GROUP', 'proxy-groups[1]'],
    ])
  })
})

describe('rules', () => {
  function rules(lines: string[]) {
    const r = imp(
      `proxies: []\nrules:\n${lines.map((l) => `  - ${JSON.stringify(l)}`).join('\n')}\n`,
    )
    return { rules: r.config?.rules ?? [], warnings: r.warnings }
  }

  it('parses nested logical rules', () => {
    expect(
      rules([
        'OR,((NOT,((DOMAIN,a.example.com))),(AND,((DST-PORT,80),(SRC-IP-CIDR,10.0.0.0/8)))),DIRECT',
      ]).rules,
    ).toEqual([
      {
        type: 'OR',
        children: [
          { type: 'NOT', children: [{ type: 'DOMAIN', value: 'a.example.com' }] },
          {
            type: 'AND',
            children: [
              { type: 'DST-PORT', value: '80' },
              { type: 'SRC-IP-CIDR', value: '10.0.0.0/8' },
            ],
          },
        ],
        target: 'DIRECT',
      },
    ])
  })

  it('trims whitespace, normalizes type case and keeps no-resolve in sub-rules', () => {
    expect(
      rules([
        'domain-suffix , a.example.com , DIRECT',
        'AND,((IP-CIDR,1.0.0.0/8,no-resolve),(DST-PORT,53)),DIRECT',
      ]).rules,
    ).toEqual([
      { type: 'DOMAIN-SUFFIX', value: 'a.example.com', target: 'DIRECT' },
      {
        type: 'AND',
        children: [
          { type: 'IP-CIDR', value: '1.0.0.0/8', noResolve: true },
          { type: 'DST-PORT', value: '53' },
        ],
        target: 'DIRECT',
      },
    ])
  })

  it('keeps the src parameter on rule types that support it', () => {
    const r = rules([
      'IP-CIDR,10.0.0.0/8,DIRECT,src',
      'IP-CIDR6,fd00::/8,DIRECT,no-resolve,src',
      'GEOIP,CN,DIRECT,src',
      'IP-ASN,64500,DIRECT,src',
      'RULE-SET,lan,DIRECT,src',
      'AND,((IP-CIDR,10.0.0.0/8,src),(DST-PORT,22)),REJECT',
    ])
    expect(r.rules).toEqual([
      { type: 'IP-CIDR', value: '10.0.0.0/8', src: true, target: 'DIRECT' },
      { type: 'IP-CIDR6', value: 'fd00::/8', noResolve: true, src: true, target: 'DIRECT' },
      { type: 'GEOIP', value: 'CN', src: true, target: 'DIRECT' },
      { type: 'IP-ASN', value: '64500', src: true, target: 'DIRECT' },
      { type: 'RULE-SET', value: 'lan', src: true, target: 'DIRECT' },
      {
        type: 'AND',
        children: [
          { type: 'IP-CIDR', value: '10.0.0.0/8', src: true },
          { type: 'DST-PORT', value: '22' },
        ],
        target: 'REJECT',
      },
    ])
    expect(r.warnings).toEqual([])
  })

  it('maps other supported rule types', () => {
    expect(
      rules([
        'IP-ASN,13335,DIRECT',
        'PROCESS-NAME,curl,DIRECT',
        'DOMAIN-REGEX,^a\\.example\\.com$,DIRECT',
      ]).rules,
    ).toEqual([
      { type: 'IP-ASN', value: '13335', target: 'DIRECT' },
      { type: 'PROCESS-NAME', value: 'curl', target: 'DIRECT' },
      { type: 'DOMAIN-REGEX', value: '^a\\.example\\.com$', target: 'DIRECT' },
    ])
  })

  it('skips unsupported and malformed rules with warnings', () => {
    const r = rules([
      'DOMAIN,ok.example.com,DIRECT',
      'PROCESS-PATH,/usr/bin/curl,DIRECT',
      'AND,((DOMAIN,a.example.com),(NETWORK,udp)),DIRECT',
      'DOMAIN,missing-target.example.com',
      'AND,((DOMAIN,a.example.com),DIRECT',
      'MATCH',
      'DOMAIN,a.example.com,DIRECT,src',
    ])
    expect(r.rules).toEqual([
      { type: 'DOMAIN', value: 'ok.example.com', target: 'DIRECT' },
      { type: 'DOMAIN', value: 'a.example.com', target: 'DIRECT' },
    ])
    expect(r.warnings.map((w) => [w.level, w.code, w.path])).toEqual([
      ['warn', 'UNSUPPORTED_RULE_TYPE', 'rules[1]'],
      ['warn', 'UNSUPPORTED_RULE_TYPE', 'rules[2]'],
      ['warn', 'INVALID_RULE', 'rules[3]'],
      ['warn', 'INVALID_RULE', 'rules[4]'],
      ['warn', 'INVALID_RULE', 'rules[5]'],
      ['info', 'UNSUPPORTED_RULE_PARAM', 'rules[6]'],
    ])
  })
})

describe('rule providers', () => {
  it('maps http providers and skips the others', () => {
    const r = imp(`proxies: []
rule-providers:
  text-set: { type: http, behavior: classical, format: text, url: "https://r.example.com/a.list", interval: 3600, proxy: DIRECT }
  mrs-set: { type: http, behavior: ipcidr, format: mrs, url: "https://r.example.com/b.mrs" }
  default-format: { type: http, behavior: domain, url: "https://r.example.com/c.yaml" }
  local: { type: file, behavior: domain, path: ./local.yaml }
  inline-set: { type: inline, behavior: domain, payload: [a.example.com] }
  bad-behavior: { type: http, behavior: foo, url: "https://r.example.com/d.yaml" }
  no-url: { type: http, behavior: domain }
`)
    expect(r.config?.ruleSets).toEqual([
      {
        id: 'text-set',
        name: 'text-set',
        behavior: 'classical',
        sources: { mihomo: { url: 'https://r.example.com/a.list', format: 'text' } },
        interval: 3600,
        extra: { mihomo: { proxy: 'DIRECT' } },
      },
      {
        id: 'mrs-set',
        name: 'mrs-set',
        behavior: 'ipcidr',
        sources: { mihomo: { url: 'https://r.example.com/b.mrs', format: 'mrs' } },
      },
      {
        id: 'default-format',
        name: 'default-format',
        behavior: 'domain',
        sources: { mihomo: { url: 'https://r.example.com/c.yaml', format: 'yaml' } },
      },
    ])
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([
      ['UNSUPPORTED_RULE_PROVIDER', 'rule-providers.local'],
      ['UNSUPPORTED_RULE_PROVIDER', 'rule-providers.inline-set'],
      ['INVALID_RULE_PROVIDER', 'rule-providers.bad-behavior'],
      ['INVALID_RULE_PROVIDER', 'rule-providers.no-url'],
    ])
  })
})

describe('general, dns and top-level extra', () => {
  it('maps general and dns fields and keeps the rest in extra', () => {
    const r = imp(`port: 7890
socks-port: 7891
allow-lan: true
bind-address: "*"
mode: Rule
log-level: warning
ipv6: false
unified-delay: true
tun: { enable: true, stack: mixed }
proxy-providers: { p1: { type: http, url: "https://p.example.com/sub" } }
dns:
  enable: true
  ipv6: false
  listen: 0.0.0.0:53
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  default-nameserver: [223.5.5.5]
  nameserver: [https://dns.example.com/dns-query]
  fallback: [tls://1.1.1.1]
  fake-ip-filter: ["*.lan"]
proxies: []
`)
    const config = r.config
    if (!config) throw new Error('config missing')
    expect(config.general).toEqual({
      port: 7890,
      socksPort: 7891,
      allowLan: true,
      bindAddress: '*',
      mode: 'rule',
      logLevel: 'warning',
      // mihomo 的 ipv6 默认为 true，false 不能省略
      ipv6: false,
    })
    expect(config.dns).toEqual({
      enable: true,
      listen: '0.0.0.0:53',
      enhancedMode: 'fake-ip',
      fakeIpRange: '198.18.0.1/16',
      defaultNameserver: ['223.5.5.5'],
      nameserver: ['https://dns.example.com/dns-query'],
      fallback: ['tls://1.1.1.1'],
      extra: { mihomo: { 'fake-ip-filter': ['*.lan'] } },
    })
    expect(config.extra).toEqual({
      mihomo: {
        'unified-delay': true,
        tun: { enable: true, stack: 'mixed' },
        'proxy-providers': { p1: { type: 'http', url: 'https://p.example.com/sub' } },
      },
    })
    // 导入的配置可以组成合法的 Profile
    expect(() =>
      ProfileSchema.parse({ version: 1, name: 'x', proxies: r.proxies, ...config }),
    ).not.toThrow()
  })

  it('keeps unknown values of mapped enums in extra', () => {
    const r = imp('mode: script\nlog-level: verbose\nproxies: []\n')
    expect(r.config?.general).toBeUndefined()
    expect(r.config?.extra).toEqual({ mihomo: { mode: 'script', 'log-level': 'verbose' } })
  })
})

describe('YAML parsing', () => {
  it('supports anchors and merge keys', () => {
    const r = imp(`base: &base { type: ss, cipher: a, password: p, port: 1 }
proxies:
  - { <<: *base, name: a, server: a.example.com }
  - { <<: *base, name: b, server: b.example.com }
`)
    expect(r.proxies.map((p) => [p.name, p.server, p.type])).toEqual([
      ['a', 'a.example.com', 'ss'],
      ['b', 'b.example.com', 'ss'],
    ])
  })

  it('tolerates duplicate keys (last one wins)', () => {
    expect(
      one(
        '{ name: s, type: ss, server: a.example.com, server: b.example.com, port: 1, cipher: a, password: p }',
      ).server,
    ).toBe('b.example.com')
  })

  it.each([
    ['malformed YAML', 'proxies: [\n  - {'],
    ['a YAML list', '- a\n- b\n'],
    ['proxies that is not a list', 'proxies: 5\n'],
  ])('reports %s as an error', (_, yaml) => {
    const r = imp(yaml)
    expect(r.proxies).toEqual([])
    expect(r.warnings).toEqual([expect.objectContaining({ level: 'error', code: 'INVALID_YAML' })])
  })
})
