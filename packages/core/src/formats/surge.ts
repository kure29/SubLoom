import type { ProxyNode, ProxyType, RuleType } from '../ir/index.js'

/**
 * Surge 格式的字段表。出处为 Surge 官方手册 https://manual.nssurge.com/ （下文只写页面路径）。
 * 以后的 Surge 导入器与导出器共用。
 */

export type ParamKind = 'string' | 'bool' | 'ports' | 'bandwidth'

export interface Param {
  /** Surge 参数名 */
  key: string
  /** IR 字段名 */
  field: string
  kind: ParamKind
}

const p = (key: string, field: string, kind: ParamKind = 'string'): Param => ({ key, field, kind })

/**
 * 各协议的专有参数（IR → Surge），按此顺序输出。vmess 的加密方式和 AEAD 由导出器单独处理。
 * - ss：policies/shadowsocks.md
 * - vmess：policies/vmess.md（username 为 UUID）
 * - trojan：policies/trojan.md
 * - hysteria2：policies/hysteria2.md（port-hopping 用分号分隔；download-bandwidth 单位 Mbps）
 * - tuic：policies/tuic.md（tuic-v5 用 uuid + password）
 * - anytls：policies/anytls.md
 * - http / socks5：policies/http.md、policies/socks5.md（username、password 也可写成命名参数）
 */
export const PROTOCOL_PARAMS: Partial<Record<ProxyType, Param[]>> = {
  ss: [p('encrypt-method', 'cipher'), p('password', 'password')],
  vmess: [p('username', 'uuid')],
  trojan: [p('password', 'password')],
  hysteria2: [
    p('password', 'password'),
    p('port-hopping', 'ports', 'ports'),
    p('download-bandwidth', 'down', 'bandwidth'),
  ],
  tuic: [p('uuid', 'uuid'), p('password', 'password')],
  anytls: [p('password', 'password')],
  http: [p('username', 'username'), p('password', 'password')],
  socks5: [p('username', 'username'), p('password', 'password')],
}

/** TLS 参数（policies/tls.md），按此顺序输出 */
export const TLS_PARAMS: Param[] = [
  p('sni', 'sni'),
  p('alpn', 'alpn'),
  p('skip-cert-verify', 'skipCertVerify', 'bool'),
  p('server-cert-fingerprint-sha256', 'certFingerprint'),
]

/** 类型关键字（policies/overview.md）；http、socks5 有 TLS 时为 https、socks5-tls */
export function surgeType(node: ProxyNode): string {
  switch (node.type) {
    case 'tuic':
      return 'tuic-v5'
    case 'http':
      return node.tls ? 'https' : 'http'
    case 'socks5':
      return node.tls ? 'socks5-tls' : 'socks5'
    default:
      return node.type
  }
}

/** Shadowsocks 支持的加密方式（policies/shadowsocks.md 的 encrypt-method） */
export const SS_CIPHERS: ReadonlySet<string> = new Set([
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  'aes-128-gcm',
  'aes-192-gcm',
  'aes-256-gcm',
  'chacha20-ietf-poly1305',
  'xchacha20-ietf-poly1305',
  'rc4',
  'rc4-md5',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'salsa20',
  'chacha20',
  'chacha20-ietf',
  'none',
])

/**
 * VMess 加密方式（policies/vmess.md：aes-128-gcm 或 chacha20-ietf-poly1305，默认 aes-128-gcm）。
 * 值为 undefined 表示使用默认值、不输出参数。
 */
export const VMESS_CIPHERS: Readonly<Record<string, string | undefined>> = {
  auto: undefined,
  'aes-128-gcm': undefined,
  'chacha20-poly1305': 'chacha20-ietf-poly1305',
  'chacha20-ietf-poly1305': 'chacha20-ietf-poly1305',
}

/** 需要 udp-relay=true 才转发 UDP 的协议（policies/udp.md）；其余受支持的协议总是转发 UDP 或不支持 UDP */
export const UDP_RELAY_TYPES: ReadonlySet<ProxyType> = new Set(['ss', 'socks5'])

/** 规则类型名（rules/overview.md 的 Rule Type Index）；未列出的与 IR 同名 */
export const RULE_TYPE_NAMES: Partial<Record<RuleType, string>> = {
  'DST-PORT': 'DEST-PORT',
  'SRC-IP-CIDR': 'SRC-IP',
  MATCH: 'FINAL',
}

/** 可以带 no-resolve 的规则（rules/overview.md 的 Rule Parameters） */
export const NO_RESOLVE_TYPES: ReadonlySet<string> = new Set([
  'IP-CIDR',
  'IP-CIDR6',
  'GEOIP',
  'IP-ASN',
  'RULE-SET',
  'DOMAIN-SET',
])

/** 日志级别（profile/general.md 的 loglevel：verbose、info、notify、warning） */
export const LOG_LEVELS = {
  debug: 'verbose',
  info: 'info',
  warning: 'warning',
  error: 'warning',
  silent: 'warning',
} as const

/** 内置策略（policies/built-in.md、policies/reject.md） */
export const BUILTIN_POLICIES: ReadonlySet<string> = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'REJECT-NO-DROP',
  'REJECT-TINYGIF',
  'CELLULAR',
  'CELLULAR-ONLY',
  'HYBRID',
  'NO-HYBRID',
])
