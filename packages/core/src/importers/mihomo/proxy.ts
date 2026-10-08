import {
  type ProxyNode,
  type ProxyType,
  ProxyTypeSchema,
  type TlsOptions,
  type Transport,
} from '../../ir/index.js'
import { extraOf, ImportError, invalid, isRecord, nest, Reader } from '../util.js'

type Kind = 'string' | 'int' | 'bool' | 'list' | 'bandwidth' | 'reserved'

interface Field {
  /** mihomo 字段名 */
  from: string
  /** IR 字段名 */
  to: string
  kind: Kind
  required?: boolean
  default?: unknown
}

const f = (from: string, to: string, kind: Kind = 'string', opts: Partial<Field> = {}): Field => ({
  from,
  to,
  kind,
  ...opts,
})

/** 各协议的专有字段（mihomo → IR） */
const PROTOCOL_FIELDS: Record<ProxyType, Field[]> = {
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
const TLS_MODE: Record<ProxyType, 'none' | 'optional' | 'always'> = {
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
const SNI_KEY: Partial<Record<ProxyType, string>> = { vmess: 'servername', vless: 'servername' }

const HAS_TRANSPORT: ReadonlySet<ProxyType> = new Set(['vmess', 'vless', 'trojan'])

function readField(r: Reader, field: Field): unknown {
  let value: unknown
  switch (field.kind) {
    case 'string':
      value = r.str(field.from)
      break
    case 'int':
      value = r.int(field.from)
      break
    case 'bool':
      value = r.bool(field.from)
      break
    case 'list':
      value = r.list(field.from)
      break
    case 'bandwidth': {
      const v = r.raw(field.from)
      value = v === undefined ? undefined : String(v)
      break
    }
    case 'reserved': {
      const v = r.raw(field.from)
      if (v !== undefined && !Array.isArray(v) && typeof v !== 'string') {
        throw invalid(`"${field.from}" must be a list or a string`)
      }
      value = v
      break
    }
  }
  if (value === undefined) {
    if (field.required) throw invalid(`"${field.from}" is required`)
    return field.default
  }
  return value
}

/**
 * mihomo 节点 → IR。返回未经 schema 校验的对象，由调用方规范化并校验。
 * 未能映射的字段按原结构放入 extra.mihomo。
 */
export function convertProxy(src: unknown): ProxyNode {
  if (!isRecord(src)) throw invalid('proxy must be a mapping')
  const r = new Reader(src)
  const typeRaw = r.str('type')
  if (typeRaw === undefined) throw invalid('"type" is required')
  const parsedType = ProxyTypeSchema.safeParse(typeRaw)
  if (!parsedType.success) {
    throw new ImportError('UNSUPPORTED_PROTOCOL', `protocol "${typeRaw}" is not supported`)
  }
  const type = parsedType.data

  const out: Record<string, unknown> = {
    name: r.requiredStr('name'),
    type,
    server: r.requiredStr('server'),
    port: r.port('port'),
    udp: r.bool('udp'),
    tfo: r.bool('tfo'),
  }
  for (const field of PROTOCOL_FIELDS[type]) out[field.to] = readField(r, field)

  const nested: Array<[string, Reader | undefined]> = []
  if (type === 'ss') readSsPlugin(r, out, nested)
  if (type === 'hysteria2') {
    const obfs = r.str('obfs')
    if (obfs !== undefined) {
      if (obfs !== 'salamander') throw invalid('"obfs" must be salamander')
      out.obfs = { type: 'salamander', password: r.requiredStr('obfs-password') }
    }
  }
  out.tls = readTls(r, type, nested)
  if (HAS_TRANSPORT.has(type)) out.transport = readTransport(r, nested)

  let rest = r.rest()
  for (const [key, child] of nested) rest = nest(rest, key, child)
  out.extra = extraOf('mihomo', rest)
  return out as ProxyNode
}

function readTls(
  r: Reader,
  type: ProxyType,
  nested: Array<[string, Reader | undefined]>,
): TlsOptions | undefined {
  const mode = TLS_MODE[type]
  if (mode === 'none') return undefined
  const enabled = r.bool('tls')
  if (mode === 'optional' && !enabled && !r.has('reality-opts')) return undefined

  const tls: TlsOptions = {
    sni: r.str(SNI_KEY[type] ?? 'sni'),
    alpn: r.list('alpn'),
    skipCertVerify: r.bool('skip-cert-verify'),
    clientFingerprint: r.str('client-fingerprint'),
    certFingerprint: r.str('fingerprint'),
  }
  const reality = r.sub('reality-opts')
  if (reality) {
    const publicKey = reality.str('public-key')
    if (!publicKey) throw invalid('"reality-opts.public-key" is required')
    tls.reality = { publicKey, shortId: reality.str('short-id') }
    nested.push(['reality-opts', reality])
  }
  const ech = r.sub('ech-opts')
  if (ech) {
    if (ech.bool('enable')) tls.ech = { config: ech.str('config') }
    nested.push(['ech-opts', ech])
  }
  return tls
}

/** 请求头：Host 单独提取，其余原样保留 */
function splitHeaders<T>(headers: Record<string, unknown> | undefined, map: (v: unknown) => T) {
  let host: T | undefined
  let rest: Record<string, T> | undefined
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === 'host') {
      host = map(v)
    } else {
      rest ??= {}
      rest[k] = map(v)
    }
  }
  return { host, headers: rest }
}

const toList = (v: unknown) => (Array.isArray(v) ? v.map(String) : [String(v)])

function readTransport(
  r: Reader,
  nested: Array<[string, Reader | undefined]>,
): Transport | undefined {
  const network = (r.str('network') ?? 'tcp').toLowerCase()
  switch (network) {
    case 'tcp':
      return undefined
    case 'ws': {
      const o = r.sub('ws-opts') ?? new Reader({})
      nested.push(['ws-opts', o])
      const path = o.str('path')
      const { host, headers } = splitHeaders(o.record('headers'), String)
      if (o.bool('v2ray-http-upgrade')) return { type: 'httpupgrade', path, host, headers }
      return {
        type: 'ws',
        path,
        host,
        headers,
        maxEarlyData: o.int('max-early-data'),
        earlyDataHeaderName: o.str('early-data-header-name'),
      }
    }
    case 'grpc': {
      const o = r.sub('grpc-opts') ?? new Reader({})
      nested.push(['grpc-opts', o])
      return { type: 'grpc', serviceName: o.str('grpc-service-name') }
    }
    case 'h2': {
      const o = r.sub('h2-opts') ?? new Reader({})
      nested.push(['h2-opts', o])
      return { type: 'h2', path: o.str('path'), host: o.list('host') }
    }
    case 'http': {
      const o = r.sub('http-opts') ?? new Reader({})
      nested.push(['http-opts', o])
      const { host, headers } = splitHeaders(o.record('headers'), toList)
      return { type: 'http', method: o.str('method'), path: o.list('path'), host, headers }
    }
    default:
      throw new ImportError('UNSUPPORTED_TRANSPORT', `transport "${network}" is not supported`)
  }
}

function readSsPlugin(
  r: Reader,
  out: Record<string, unknown>,
  nested: Array<[string, Reader | undefined]>,
) {
  const plugin = r.peek('plugin')
  if (plugin !== 'obfs' && plugin !== 'v2ray-plugin') return // 其他插件整体留在 extra
  const optsRaw = r.peek('plugin-opts')
  const o = new Reader(isRecord(optsRaw) ? optsRaw : {}, 'plugin-opts')
  if (plugin === 'obfs') {
    const mode = o.str('mode')
    if (mode !== 'http' && mode !== 'tls') throw invalid('"plugin-opts.mode" must be http or tls')
    out.plugin = { type: 'obfs', mode, host: o.str('host') }
  } else {
    if ((o.peek('mode') ?? 'websocket') !== 'websocket') return
    o.consume('mode')
    out.plugin = {
      type: 'v2ray-plugin',
      mode: 'websocket',
      host: o.str('host'),
      path: o.str('path'),
      tls: o.bool('tls'),
      mux: o.bool('mux'),
      skipCertVerify: o.bool('skip-cert-verify'),
      headers: o.record('headers'),
    }
  }
  r.consume('plugin', 'plugin-opts')
  nested.push(['plugin-opts', o])
}
