import {
  BUILTIN_POLICIES,
  LOG_LEVELS,
  NO_RESOLVE_TYPES,
  type Param,
  PROTOCOL_PARAMS,
  RULE_TYPE_NAMES,
  SS_CIPHERS,
  surgeType,
  TLS_PARAMS,
  UDP_RELAY_TYPES,
  VMESS_CIPHERS,
} from '../../formats/surge.js'
import {
  type DnsConfig,
  type GeneralConfig,
  LOGICAL_RULE_TYPES,
  type Profile,
  type ProxyGroupType,
  type ProxyNode,
  type RuleCondition,
  RuleTypeSchema,
  type TlsOptions,
} from '../../ir/index.js'
import {
  type AdaptedProxy,
  ExportContext,
  type ProxyWarn,
  type ResolvedGroup,
  type ResolvedProfile,
  type ResolvedProxy,
  type ResolvedRuleSet,
  resolveProfile,
  type TargetSpec,
} from '../resolve.js'
import type { Capabilities, Exporter, ExportOptions, ExportResult } from '../types.js'
import { isRecord } from '../util.js'

/**
 * Surge 的能力矩阵，以 Surge 官方手册 https://manual.nssurge.com/ 为准（2026-10 版本）。
 * 不支持的子功能如何处理见下方 adaptProxy 和 PLAN.md 4 节"Surge 导出器"。
 */
export const SURGE_CAPABILITIES: Capabilities = {
  // policies/overview.md 的 Supported Proxy Protocols：没有 ssr、vless
  proxyTypes: [
    'ss',
    'vmess',
    'trojan',
    'hysteria2',
    'tuic',
    'wireguard',
    'anytls',
    'http',
    'socks5',
  ],
  // policy-groups/overview.md 的 Group Types（另有 smart、subnet，IR 中没有）
  groupTypes: ['select', 'url-test', 'fallback', 'load-balance'],
  // rules/overview.md 的 Rule Type Index：没有 DOMAIN-REGEX、GEOSITE；
  // DST-PORT、SRC-IP-CIDR、MATCH 在 Surge 中叫 DEST-PORT、SRC-IP、FINAL；PROCESS-NAME 只在 Mac 上生效
  ruleTypes: RuleTypeSchema.options.filter((t) => t !== 'DOMAIN-REGEX' && t !== 'GEOSITE'),
  // rules/logical.md
  logicalRules: true,
  // rules/ruleset.md：list 为规则列表（RULE-SET）；rules/domain.md：text 为域名列表（DOMAIN-SET，只用于 domain）
  ruleSetFormats: ['list', 'text'],
  // rules/ruleset.md 的 Options on the RULE-SET Line 只有 no-resolve、extended-matching、update-interval、
  // pre-matching，没有指定下载策略的参数
  ruleSetProxy: false,
}

const FULLWIDTH: Record<string, string> = { '#': '＃', '//': '／／', ';': '；' }

/**
 * 策略名不能加引号（policies/overview.md 只允许给参数值加引号），而 `,` 分隔成员和规则、
 * `=` 分隔名称和定义，空白后的 #、//、; 是行内注释（profile/format.md 的 Comments）。
 */
function sanitizeName(name: string): string {
  return name
    .replace(/,/g, '，')
    .replace(/=/g, '＝')
    .replace(/(\s)(#|\/\/|;)/g, (_, space: string, mark: string) => space + FULLWIDTH[mark])
}

/** 含逗号、引号、首尾空白或行内注释符的值加双引号（profile/format.md 的 Quoted Values） */
function quote(v: string): string {
  if (!/[,"]|^\s|\s$|\s(?:#|\/\/|;)/.test(v)) return v
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const param = (key: string, value: string) => `${key}=${quote(value)}`

function paramValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map((x) => paramValue(x) ?? '').join(',')
  return undefined
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const IPV6 = /^[0-9a-fA-F:.]*:[0-9a-fA-F:.]*$/
const isIp = (s: string) => IPV4.test(s) || IPV6.test(s)

/** 地址后可带端口：1.1.1.1、1.1.1.1:53、::1、[::1]:53 */
function isIpWithPort(s: string): boolean {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(s)
  if (v6?.[1]) return IPV6.test(v6[1])
  return isIp(s) || /^(?:\d{1,3}\.){3}\d{1,3}:\d+$/.test(s)
}

/** 带宽 → Mbps；无法识别时为 undefined。纯数字按 Mbps（与 mihomo 一致） */
function mbps(v: string): string | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)(?:bps)?$/i.exec(v.trim())
  if (!m?.[1]) return undefined
  const n = Number(m[1])
  const unit = (m[2] ?? '').toLowerCase()
  return String(unit === 'g' ? n * 1000 : unit === 'k' ? n / 1000 : n)
}

/** server-cert-fingerprint-sha256 要求 64 位十六进制（policies/tls.md），允许来源中带冒号 */
function fingerprint(v: string): string | undefined {
  const hex = v.replace(/:/g, '')
  return /^[0-9a-fA-F]{64}$/.test(hex) ? hex.toLowerCase() : undefined
}

const without = <T extends object>(o: T, ...keys: string[]): T => {
  const out = { ...o } as Record<string, unknown>
  for (const k of keys) delete out[k]
  return out as T
}

/** WireGuard 段需要的附加数据 */
interface WireguardData {
  dns: string[]
}

/** 本地 WireGuard 节点在 extra.mihomo 中、由 Surge 导出器使用的键 */
const WG_DNS_KEYS = ['dns', 'remote-dns-resolve']

function adaptTls(tls: TlsOptions, warn: ProxyWarn): TlsOptions | undefined {
  if (tls.reality) {
    warn('tls.reality', 'dropped', 'Surge does not support REALITY')
    return undefined
  }
  if (tls.certFingerprint !== undefined && !fingerprint(tls.certFingerprint)) {
    warn('tls.certFingerprint', 'dropped', 'Surge only accepts a SHA-256 certificate fingerprint')
    return undefined
  }
  let out = tls
  if (tls.clientFingerprint) {
    warn('tls.clientFingerprint', 'downgraded', 'Surge does not support uTLS fingerprints')
    out = without(out, 'clientFingerprint')
  }
  if (tls.ech) {
    warn('tls.ech', 'downgraded', 'Surge does not support ECH; the real SNI is sent in plain text')
    out = without(out, 'ech')
  }
  return out
}

/**
 * 节点子功能检查。影响连通性的（传输层、插件、REALITY、加密方式等）移除节点；
 * 不影响连通性的可选项去掉字段并警告。先做所有会移除节点的检查，再做降级。
 */
function adaptProxy(node: ProxyNode, warn: ProxyWarn): AdaptedProxy | undefined {
  // —— 会移除节点的检查 ——
  if (node.type === 'ss') {
    if (node.plugin?.type === 'v2ray-plugin') {
      warn('plugin', 'dropped', 'Surge does not support v2ray-plugin')
      return undefined
    }
    if (!SS_CIPHERS.has(node.cipher)) {
      warn('cipher', 'dropped', 'Surge does not support this Shadowsocks cipher')
      return undefined
    }
  }
  if ((node.type === 'vmess' || node.type === 'trojan') && node.transport) {
    const t = node.transport
    if (t.type !== 'ws') {
      warn('transport', 'dropped', `Surge does not support the ${t.type} transport`)
      return undefined
    }
    const headers = [t.host ?? '', ...Object.entries(t.headers ?? {}).flat()]
    if (headers.some((h) => h.includes('|'))) {
      warn('transport.headers', 'dropped', 'Surge cannot write WebSocket headers containing "|"')
      return undefined
    }
  }
  if (node.type === 'hysteria2' && node.password === undefined) {
    warn('password', 'dropped', 'Surge requires a Hysteria 2 password')
    return undefined
  }
  let data: WireguardData | undefined
  if (node.type === 'wireguard') {
    if (!node.ip && !node.ipv6) {
      warn('ip', 'dropped', 'Surge requires the tunnel address of a WireGuard policy')
      return undefined
    }
    // 没有 dns-server 的 WireGuard 策略在 Surge 中无法解析目标域名（policies/wireguard.md）
    const dns = node.extra?.mihomo?.dns
    const ips = (Array.isArray(dns) ? dns : []).filter(
      (d): d is string => typeof d === 'string' && isIp(d),
    )
    if (!ips.length) {
      warn('extra.mihomo.dns', 'dropped', 'Surge needs a DNS server inside the WireGuard tunnel')
      return undefined
    }
    data = { dns: ips }
  }
  let tls = 'tls' in node ? node.tls : undefined
  if (tls) {
    tls = adaptTls(tls, warn)
    if (!tls) return undefined
  }

  // —— 降级 ——
  let out: ProxyNode = tls ? ({ ...node, tls } as ProxyNode) : node
  if (out.type === 'vmess' && !(out.cipher in VMESS_CIPHERS)) {
    warn('cipher', 'downgraded', 'Surge does not support this VMess cipher; the default is used')
    out = { ...out, cipher: 'auto' }
  }
  if ((out.type === 'vmess' || out.type === 'trojan') && out.transport?.type === 'ws') {
    let t = out.transport
    for (const key of ['maxEarlyData', 'earlyDataHeaderName'] as const) {
      if (t[key] === undefined) continue
      warn(`transport.${key}`, 'downgraded', 'Surge does not support WebSocket early data')
      t = without(t, key)
    }
    out = { ...out, transport: t }
  }
  if (out.type === 'hysteria2') {
    if (out.up !== undefined) {
      warn('up', 'downgraded', 'Surge only accepts the download bandwidth')
      out = without(out, 'up')
    }
    if (out.down !== undefined && mbps(out.down) === undefined) {
      warn('down', 'downgraded', 'the bandwidth cannot be converted to Mbps')
      out = without(out, 'down')
    }
    if (out.obfs) {
      warn(
        'obfs',
        'kept',
        'the Surge manual lists Salamander obfuscation for Surge Mac only',
        'info',
      )
    }
  }
  if (out.type === 'tuic') {
    for (const key of ['congestionController', 'udpRelayMode', 'reduceRtt'] as const) {
      if (out[key] === undefined) continue
      warn(key, 'downgraded', `Surge has no TUIC option for ${key}`)
      out = without(out, key)
    }
  }
  if (out.type === 'wireguard' && isRecord(out.extra?.mihomo)) {
    // dns 已用于 dns-server；只剩这些键时不再给出 EXTRA_IGNORED
    const mihomo = without(out.extra.mihomo, ...WG_DNS_KEYS)
    const extra = Object.keys(mihomo).length
      ? { ...out.extra, mihomo }
      : without(out.extra, 'mihomo')
    out = Object.keys(extra).length ? { ...out, extra } : without(out, 'extra')
  }
  return data ? { node: out, data } : { node: out }
}

export const SURGE_SPEC: TargetSpec = {
  target: 'surge',
  capabilities: SURGE_CAPABILITIES,
  builtins: BUILTIN_POLICIES,
  ruleSetSource(set) {
    const source = set.sources.surge
    if (!source) return { code: 'RULE_SET_NO_SOURCE', message: 'the rule set has no Surge source' }
    if (source.format === 'list' || (source.format === 'text' && set.behavior === 'domain')) {
      return source
    }
    return {
      code: 'UNSUPPORTED_RULE_SET_FORMAT',
      message: `Surge does not support the ${source.format} format with ${set.behavior} behavior`,
    }
  },
  adaptProxy,
  // IP-CIDR、IP-CIDR6 的 src 可以写成 SRC-IP（rules/source-and-port.md），其余无法表达
  checkRule: (c) =>
    c.src && c.type !== 'IP-CIDR' && c.type !== 'IP-CIDR6'
      ? {
          code: 'UNSUPPORTED_RULE_PARAM',
          message: `Surge cannot match ${c.type} rules against the source address`,
        }
      : undefined,
  sanitizeName,
}

// —— 节点 ——

function tableParams(src: Record<string, unknown>, table: Param[]): string[] {
  const out: string[] = []
  for (const { key, field, kind } of table) {
    const v = src[field]
    if (v === undefined) continue
    if (kind === 'bool') {
      if (v === true) out.push(`${key}=true`)
    } else if (kind === 'ports') {
      out.push(param(key, String(v).replace(/,/g, ';')))
    } else if (kind === 'bandwidth') {
      const n = mbps(String(v))
      if (n !== undefined) out.push(param(key, n))
    } else if (field === 'alpn' && Array.isArray(v)) {
      out.push(param(key, v.join(',')))
    } else if (field === 'certFingerprint') {
      out.push(param(key, fingerprint(String(v)) ?? String(v)))
    } else {
      out.push(param(key, String(v)))
    }
  }
  return out
}

function wsParams(node: ProxyNode): string[] {
  if (!('transport' in node) || node.transport?.type !== 'ws') return []
  const t = node.transport
  const headers = [
    ...(t.host === undefined ? [] : [`Host:${t.host}`]),
    ...Object.entries(t.headers ?? {}).map(([k, v]) => `${k}:${v}`),
  ]
  return [
    'ws=true',
    ...(t.path === undefined ? [] : [param('ws-path', t.path)]),
    ...(headers.length ? [param('ws-headers', headers.join('|'))] : []),
  ]
}

/** extra.surge 追加在行尾：已有的参数（IR 字段）优先；true 写成 key=true */
function extraParams(extra: Record<string, unknown> | undefined, written: string[]): string[] {
  if (!extra) return []
  const keys = new Set(written.map((w) => w.split('=')[0]))
  const out: string[] = []
  for (const [k, v] of Object.entries(extra)) {
    const s = paramValue(v)
    if (s !== undefined && !keys.has(k)) out.push(param(k, s))
  }
  return out
}

function proxyLine(
  { node, name, extra }: ResolvedProxy,
  defaultUdp: boolean,
  section: string | undefined,
): string {
  const src = node as Record<string, unknown>
  const params: string[] = []
  if (section !== undefined) {
    params.push(param('section-name', section))
  } else {
    params.push(...tableParams(src, PROTOCOL_PARAMS[node.type] ?? []))
    if (node.type === 'vmess') {
      const cipher = VMESS_CIPHERS[node.cipher]
      if (cipher) params.push(param('encrypt-method', cipher))
      if (node.alterId === 0) params.push('vmess-aead=true')
    }
    if (node.type === 'ss' && node.plugin?.type === 'obfs') {
      params.push(param('obfs', node.plugin.mode))
      if (node.plugin.host) params.push(param('obfs-host', node.plugin.host))
    }
    if (node.type === 'hysteria2' && node.obfs) {
      params.push(param('salamander-password', node.obfs.password))
    }
    params.push(...wsParams(node))
    if ('tls' in node && node.tls) {
      if (node.type === 'vmess') params.push('tls=true')
      params.push(...tableParams(node.tls as Record<string, unknown>, TLS_PARAMS))
    }
    if (UDP_RELAY_TYPES.has(node.type) && (node.udp ?? defaultUdp)) params.push('udp-relay=true')
  }
  if (node.tfo) params.push('tfo=true')
  params.push(...extraParams(extra, params))
  const head =
    section !== undefined ? [surgeType(node)] : [surgeType(node), node.server, String(node.port)]
  return `${name} = ${[...head, ...params].join(', ')}`
}

/** [WireGuard <段名>]（policies/wireguard.md） */
function wireguardSection(node: Extract<ProxyNode, { type: 'wireguard' }>, dns: string[]) {
  const addr = (a: string) => a.replace(/\/\d+$/, '')
  const allowed = [...(node.ip ? ['0.0.0.0/0'] : []), ...(node.ipv6 ? ['::/0'] : [])]
  const host = node.server.includes(':') ? `[${node.server}]` : node.server
  const reserved = Array.isArray(node.reserved) ? node.reserved.join('/') : node.reserved
  const peer = [
    `public-key = ${quote(node.publicKey)}`,
    `allowed-ips = ${quote(allowed.join(', '))}`,
    `endpoint = ${host}:${node.port}`,
    ...(node.preSharedKey ? [`preshared-key = ${quote(node.preSharedKey)}`] : []),
    ...(reserved === undefined ? [] : [`client-id = ${quote(String(reserved))}`]),
  ]
  return [
    `private-key = ${node.privateKey}`,
    ...(node.ip ? [`self-ip = ${addr(node.ip)}`] : []),
    ...(node.ipv6 ? [`self-ip-v6 = ${addr(node.ipv6)}`] : []),
    `dns-server = ${dns.join(', ')}`,
    ...(node.mtu === undefined ? [] : [`mtu = ${node.mtu}`]),
    `peer = (${peer.join(', ')})`,
  ]
}

// —— 策略组 ——

/** (?i) 开头的正则写成 (?i:…)，以便放进前瞻 */
const scoped = (re: string) => (re.startsWith('(?i)') ? `(?i:${re.slice(4)})` : `(?:${re})`)

/** Surge 只有 policy-regex-filter（policy-groups/policy-including.md），排除条件合并为前瞻 */
function regexFilter(group: ResolvedGroup, ctx: ExportContext): string | undefined {
  const f = group.group.filter
  if (!f?.exclude) return f?.include
  ctx.warn(
    'GROUP_FILTER_REWRITTEN',
    `${group.path}.filter`,
    'kept',
    'Surge has no exclude filter; include and exclude were merged into one regular expression',
    'info',
  )
  const include = f.include === undefined ? '' : `(?=.*${scoped(f.include)})`
  return `^${include}(?!.*${scoped(f.exclude)})`
}

/** interval 用于自动测试的组，tolerance 只用于 url-test（policy-groups/url-test.md 等） */
const USES_INTERVAL: ReadonlySet<ProxyGroupType> = new Set(['url-test', 'fallback', 'load-balance'])

function groupLine(group: ResolvedGroup, testUrl: string | undefined, ctx: ExportContext): string {
  const g = group.group
  const params: string[] = []
  if (g.includeAllProxies) params.push('include-all-proxies=true')
  const filter = regexFilter(group, ctx)
  if (filter !== undefined) params.push(param('policy-regex-filter', filter))
  if (g.testUrl !== undefined && g.testUrl !== testUrl) {
    ctx.warn(
      'UNSUPPORTED_GROUP_OPTION',
      `${group.path}.testUrl`,
      'downgraded',
      'Surge has a single global test URL (proxy-test-url); this group uses it instead',
    )
  }
  if (g.interval !== undefined) {
    if (USES_INTERVAL.has(group.type)) params.push(`interval=${g.interval}`)
    else {
      ctx.warn(
        'UNSUPPORTED_GROUP_OPTION',
        `${group.path}.interval`,
        'dropped',
        'unused by this group type in Surge',
      )
    }
  }
  if (g.tolerance !== undefined) {
    if (group.type === 'url-test') params.push(`tolerance=${g.tolerance}`)
    else {
      ctx.warn(
        'UNSUPPORTED_GROUP_OPTION',
        `${group.path}.tolerance`,
        'dropped',
        'Surge only uses tolerance in url-test groups',
      )
    }
  }
  if (g.hidden) params.push('hidden=true')
  if (g.icon !== undefined) params.push(param('icon-url', g.icon))
  params.push(...extraParams(group.extra, params))
  return `${group.name} = ${[group.type, ...group.members, ...params].join(', ')}`
}

// —— 规则 ——

function ruleText(
  c: RuleCondition,
  sets: ReadonlyMap<string, ResolvedRuleSet>,
  target?: string,
): string {
  if (LOGICAL_RULE_TYPES.has(c.type)) {
    const children = (c.children ?? []).map((child) => `(${ruleText(child, sets)})`).join(',')
    return [c.type, `(${children})`, ...(target === undefined ? [] : [target])].join(',')
  }
  let type = RULE_TYPE_NAMES[c.type] ?? c.type
  let value = c.value
  const set = c.type === 'RULE-SET' ? sets.get(c.value ?? '') : undefined
  if (set) {
    type = set.source.format === 'text' ? 'DOMAIN-SET' : 'RULE-SET'
    value = set.source.url
  }
  // IP-CIDR、IP-CIDR6 + src 即 SRC-IP（rules/source-and-port.md）
  if (c.src) type = 'SRC-IP'
  const parts = [type, ...(value === undefined ? [] : [quote(value)])]
  if (target === undefined) {
    if (c.noResolve && NO_RESOLVE_TYPES.has(type)) parts.push('no-resolve')
    return parts.join(',')
  }
  parts.push(target)
  if (c.noResolve && NO_RESOLVE_TYPES.has(type)) parts.push('no-resolve')
  if (set?.set.interval !== undefined) parts.push(`update-interval=${set.set.interval}`)
  if (set) parts.push(...extraParams(set.extra, parts))
  return parts.join(',')
}

/** 规则以 FINAL 结尾；多个 FINAL 时 Surge 以最后一个为准（rules/final.md），因此只导出到第一条 MATCH */
function ruleLines(r: ResolvedProfile, ctx: ExportContext): string[] {
  const out: string[] = []
  let final = false
  for (const { rule, path, target } of r.rules) {
    if (final) {
      ctx.warn(
        'UNREACHABLE_RULE',
        path,
        'dropped',
        'rules after the first MATCH never take effect',
        'info',
      )
      continue
    }
    out.push(ruleText(rule, r.ruleSets, target))
    if (rule.type === 'MATCH') final = true
  }
  if (!final) {
    out.push('FINAL,DIRECT')
    ctx.warn(
      'MISSING_FINAL_RULE',
      'rules',
      'downgraded',
      'Surge requires a FINAL rule; FINAL,DIRECT was added',
    )
  }
  return out
}

// —— General / DNS ——

const UNSUPPORTED_GENERAL: Array<keyof GeneralConfig> = [
  'port',
  'socksPort',
  'redirPort',
  'tproxyPort',
  'mixedPort',
  'allowLan',
  'bindAddress',
  'mode',
]
const UNSUPPORTED_DNS: Array<keyof DnsConfig> = [
  'enable',
  'ipv6',
  'listen',
  'enhancedMode',
  'fakeIpRange',
  'fallback',
]

/** DNS 服务器（dns/dns-server.md、dns/encrypted-dns.md） */
function dnsServer(s: string): { plain?: string; encrypted?: string } | undefined {
  if (s.includes('#')) return undefined
  if (s === 'system' || s.startsWith('tcp://')) return { plain: s }
  if (/^(?:https|tls|quic|h3):\/\//.test(s)) return { encrypted: s }
  const addr = s.startsWith('udp://') ? s.slice(6) : s
  return isIpWithPort(addr) ? { plain: addr } : undefined
}

function generalLines(profile: Profile, ctx: ExportContext) {
  const general = profile.general ?? {}
  const dns = profile.dns ?? {}
  const lines: string[] = []
  if (general.logLevel !== undefined) {
    if (general.logLevel === 'silent') {
      ctx.warn(
        'UNSUPPORTED_SETTING',
        'general.logLevel',
        'downgraded',
        'Surge has no silent log level; warning is used',
      )
    }
    lines.push(`loglevel = ${LOG_LEVELS[general.logLevel]}`)
  }
  const ipv6 = general.ipv6 ?? dns.ipv6
  if (ipv6 !== undefined) lines.push(`ipv6 = ${ipv6}`)
  for (const key of UNSUPPORTED_GENERAL) {
    if (general[key] === undefined) continue
    ctx.warn(
      'UNSUPPORTED_SETTING',
      `general.${key}`,
      'dropped',
      'Surge has no matching profile setting',
    )
  }
  const generalExtra = ctx.extra(general.extra, 'general')

  for (const key of UNSUPPORTED_DNS) {
    if (dns[key] === undefined) continue
    // ipv6 已写入 General，只有与 general.ipv6 不同时才是丢弃
    if (key === 'ipv6' && (general.ipv6 === undefined || general.ipv6 === dns.ipv6)) continue
    ctx.warn('UNSUPPORTED_SETTING', `dns.${key}`, 'dropped', 'Surge has no matching DNS setting')
  }
  const plain: string[] = []
  const encrypted: string[] = []
  const servers = [
    ...(dns.nameserver ?? []).map((s, i) => ({ s, path: `dns.nameserver[${i}]` })),
    ...(dns.defaultNameserver ?? []).map((s, i) => ({ s, path: `dns.defaultNameserver[${i}]` })),
  ]
  for (const { s, path } of servers) {
    const server = dnsServer(s)
    if (!server) {
      ctx.warn(
        'UNSUPPORTED_DNS_SERVER',
        path,
        'dropped',
        'Surge cannot use this DNS server address',
      )
      continue
    }
    if (server.plain !== undefined && !plain.includes(server.plain)) plain.push(server.plain)
    if (server.encrypted !== undefined && !encrypted.includes(server.encrypted)) {
      encrypted.push(server.encrypted)
    }
  }
  if (plain.length) lines.push(`dns-server = ${plain.join(', ')}`)
  if (encrypted.length) lines.push(`encrypted-dns-server = ${encrypted.join(', ')}`)
  // general.extra.surge 在前，dns.extra.surge 中的同名键忽略
  const extra: Record<string, unknown> = { ...generalExtra }
  for (const [k, v] of Object.entries(ctx.extra(dns.extra, 'dns') ?? {}))
    if (!(k in extra)) extra[k] = v
  return { lines, extra }
}

/** general.extra.surge 的值：数组用 ", " 连接 */
function settingValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.map((x) => paramValue(x) ?? '').join(', ')
  return paramValue(v)
}

/** Surge 生成的段，不能由 profile.extra.surge 覆盖 */
const GENERATED_SECTIONS = new Set(['General', 'Proxy', 'Proxy Group', 'Rule'])

function extraSections(profile: Profile, ctx: ExportContext): Array<[string, string[]]> {
  const extra = ctx.extra(profile.extra, '')
  const out: Array<[string, string[]]> = []
  for (const [name, lines] of Object.entries(extra ?? {})) {
    const valid =
      !GENERATED_SECTIONS.has(name) &&
      !name.startsWith('WireGuard ') &&
      Array.isArray(lines) &&
      lines.every((l) => typeof l === 'string')
    if (!valid) {
      ctx.warn(
        'EXTRA_IGNORED',
        `extra.surge.${name}`,
        'dropped',
        'extra Surge sections must be lists of lines and cannot replace generated sections',
      )
      continue
    }
    out.push([name, lines as string[]])
  }
  return out
}

/** 导出 Surge 配置。nodes 是经过流水线处理的订阅节点，输出在 profile.proxies 之后。 */
export function exportSurge(
  profile: Profile,
  nodes: readonly ProxyNode[],
  opts: ExportOptions = {},
): ExportResult {
  const ctx = new ExportContext('surge')
  const defaultUdp = opts.defaultUdp ?? true
  const general = generalLines(profile, ctx)
  const r = resolveProfile(SURGE_SPEC, profile, nodes, opts, ctx)

  const proxies: string[] = []
  const wireguard: Array<[string, string[]]> = []
  for (const p of r.proxies) {
    let section: string | undefined
    if (p.node.type === 'wireguard') {
      section = `wg${wireguard.length + 1}`
      wireguard.push([
        `WireGuard ${section}`,
        wireguardSection(p.node, (p.data as WireguardData).dns),
      ])
    }
    proxies.push(proxyLine(p, defaultUdp, section))
  }

  // Surge 没有组级测速地址（policy-groups/url-test.md）：用全局 proxy-test-url（profile/general.md）
  const explicitTestUrl = paramValue(general.extra['proxy-test-url'])
  const testUrl = explicitTestUrl ?? r.groups.find((g) => g.group.testUrl)?.group.testUrl
  const groups = r.groups.map((g) => groupLine(g, testUrl, ctx))
  const rules = ruleLines(r, ctx)

  if (testUrl !== undefined && explicitTestUrl === undefined) {
    general.lines.push(`proxy-test-url = ${testUrl}`)
  }
  for (const [k, v] of Object.entries(general.extra)) {
    const s = settingValue(v)
    if (s !== undefined) general.lines.push(`${k} = ${s}`)
  }

  const sections: Array<[string, string[]]> = [
    ['General', general.lines],
    ['Proxy', proxies],
    ['Proxy Group', groups],
    ['Rule', rules],
    ...wireguard,
    ...extraSections(profile, ctx),
  ]
  const text = `${sections.map(([name, lines]) => [`[${name}]`, ...lines].join('\n')).join('\n\n')}\n`
  return { text, warnings: ctx.warnings }
}

export const surgeExporter: Exporter = {
  target: 'surge',
  capabilities: SURGE_CAPABILITIES,
  export: exportSurge,
}
