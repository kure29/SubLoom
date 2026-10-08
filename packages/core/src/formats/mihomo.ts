import type { ProxyType } from '../ir/index.js'

/** mihomo 格式的字段表，导入器和导出器共用 */

export type FieldKind = 'string' | 'int' | 'bool' | 'list' | 'bandwidth' | 'reserved'

export interface Field {
  /** mihomo 字段名 */
  from: string
  /** IR 字段名 */
  to: string
  kind: FieldKind
  required?: boolean
  /** 导入时的缺省值 */
  default?: unknown
}

const f = (
  from: string,
  to: string,
  kind: FieldKind = 'string',
  opts: Partial<Field> = {},
): Field => ({ from, to, kind, ...opts })

/** 各协议的专有字段（mihomo ↔ IR），导出时按此顺序输出 */
export const PROTOCOL_FIELDS: Record<ProxyType, Field[]> = {
  ss: [
    f('cipher', 'cipher', 'string', { required: true }),
    f('password', 'password', 'string', { required: true }),
  ],
  ssr: [
    f('cipher', 'cipher', 'string', { required: true }),
    f('password', 'password', 'string', { required: true }),
    f('obfs', 'obfs', 'string', { required: true }),
    f('obfs-param', 'obfsParam'),
    f('protocol', 'protocol', 'string', { required: true }),
    f('protocol-param', 'protocolParam'),
  ],
  vmess: [
    f('uuid', 'uuid', 'string', { required: true }),
    f('alterId', 'alterId', 'int', { default: 0 }),
    f('cipher', 'cipher', 'string', { default: 'auto' }),
  ],
  vless: [f('uuid', 'uuid', 'string', { required: true }), f('flow', 'flow')],
  trojan: [f('password', 'password', 'string', { required: true })],
  hysteria2: [
    f('password', 'password'),
    f('ports', 'ports'),
    f('up', 'up', 'bandwidth'),
    f('down', 'down', 'bandwidth'),
  ],
  tuic: [
    f('uuid', 'uuid', 'string', { required: true }),
    f('password', 'password', 'string', { required: true }),
    f('congestion-controller', 'congestionController'),
    f('udp-relay-mode', 'udpRelayMode'),
    f('reduce-rtt', 'reduceRtt', 'bool'),
  ],
  wireguard: [
    f('private-key', 'privateKey', 'string', { required: true }),
    f('public-key', 'publicKey', 'string', { required: true }),
    f('pre-shared-key', 'preSharedKey'),
    f('ip', 'ip'),
    f('ipv6', 'ipv6'),
    f('reserved', 'reserved', 'reserved'),
    f('mtu', 'mtu', 'int'),
  ],
  anytls: [f('password', 'password', 'string', { required: true })],
  http: [f('username', 'username'), f('password', 'password')],
  socks5: [f('username', 'username'), f('password', 'password')],
}

/** none：无 TLS；optional：由 tls: true 开启；always：协议自带 TLS */
export const TLS_MODE: Record<ProxyType, 'none' | 'optional' | 'always'> = {
  ss: 'none',
  ssr: 'none',
  vmess: 'optional',
  vless: 'optional',
  trojan: 'always',
  hysteria2: 'always',
  tuic: 'always',
  wireguard: 'none',
  anytls: 'always',
  http: 'optional',
  socks5: 'optional',
}

/** vmess / vless 的 SNI 字段叫 servername，其余协议叫 sni */
export const SNI_KEY: Partial<Record<ProxyType, string>> = {
  vmess: 'servername',
  vless: 'servername',
}

export const HAS_TRANSPORT: ReadonlySet<ProxyType> = new Set(['vmess', 'vless', 'trojan'])

/** 未写 udp 时 mihomo 的行为：hysteria2、tuic 总是开启 UDP，其余默认关闭 */
export const DEFAULT_UDP: Partial<Record<ProxyType, boolean>> = { hysteria2: true, tuic: true }

/** 顶层通用字段（mihomo 键 → IR 字段），导出时按此顺序输出 */
export const GENERAL_KEYS = [
  ['port', 'port'],
  ['socks-port', 'socksPort'],
  ['redir-port', 'redirPort'],
  ['tproxy-port', 'tproxyPort'],
  ['mixed-port', 'mixedPort'],
  ['allow-lan', 'allowLan'],
  ['bind-address', 'bindAddress'],
  ['mode', 'mode'],
  ['log-level', 'logLevel'],
  ['ipv6', 'ipv6'],
] as const

export const DNS_KEYS = [
  ['enable', 'enable'],
  ['ipv6', 'ipv6'],
  ['listen', 'listen'],
  ['enhanced-mode', 'enhancedMode'],
  ['fake-ip-range', 'fakeIpRange'],
  ['default-nameserver', 'defaultNameserver'],
  ['nameserver', 'nameserver'],
  ['fallback', 'fallback'],
] as const

/** 规则参数 */
export const NO_RESOLVE = 'no-resolve'
export const SRC = 'src'
