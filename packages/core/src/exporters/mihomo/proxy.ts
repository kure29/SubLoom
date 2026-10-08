import { PROTOCOL_FIELDS, SNI_KEY, TLS_MODE } from '../../formats/mihomo.js'
import type { ProxyNode, ProxyType, SsPlugin, TlsOptions, Transport } from '../../ir/index.js'
import { compact, mergeExtra } from '../util.js'

/** 纯数字的带宽写成数字（mihomo 按 Mbps 解释），其余原样 */
const bandwidth = (v: unknown) => (typeof v === 'string' && /^[1-9]\d*$/.test(v) ? Number(v) : v)

function tlsFields(type: ProxyType, tls: TlsOptions): Record<string, unknown> {
  return {
    tls: TLS_MODE[type] === 'optional' ? true : undefined,
    [SNI_KEY[type] ?? 'sni']: tls.sni,
    alpn: tls.alpn,
    'skip-cert-verify': tls.skipCertVerify,
    'client-fingerprint': tls.clientFingerprint,
    fingerprint: tls.certFingerprint,
    'reality-opts':
      tls.reality &&
      compact({ 'public-key': tls.reality.publicKey, 'short-id': tls.reality.shortId }),
    'ech-opts': tls.ech && compact({ enable: true, config: tls.ech.config }),
  }
}

/** Host 放回请求头 */
const withHost = <T>(host: T | undefined, headers: Record<string, T> | undefined) =>
  host === undefined ? headers : { Host: host, ...headers }

/** 传输层 → network + <network>-opts，选项为空时不输出 opts */
const TRANSPORT: {
  [K in Transport['type']]: (t: Extract<Transport, { type: K }>) => [string, string, unknown]
} = {
  ws: (t) => [
    'ws',
    'ws-opts',
    {
      path: t.path,
      headers: withHost(t.host, t.headers),
      'max-early-data': t.maxEarlyData,
      'early-data-header-name': t.earlyDataHeaderName,
    },
  ],
  httpupgrade: (t) => [
    'ws',
    'ws-opts',
    { path: t.path, headers: withHost(t.host, t.headers), 'v2ray-http-upgrade': true },
  ],
  grpc: (t) => ['grpc', 'grpc-opts', { 'grpc-service-name': t.serviceName }],
  h2: (t) => ['h2', 'h2-opts', { host: t.host, path: t.path }],
  http: (t) => [
    'http',
    'http-opts',
    { method: t.method, path: t.path, headers: withHost(t.host, t.headers) },
  ],
}

function transportFields(t: Transport): Record<string, unknown> {
  const [network, key, opts] = (TRANSPORT[t.type] as (t: Transport) => [string, string, unknown])(t)
  return { network, [key]: compact(opts as Record<string, unknown>) }
}

const SS_PLUGIN: { [K in SsPlugin['type']]: (p: Extract<SsPlugin, { type: K }>) => unknown } = {
  obfs: (p) => ({ mode: p.mode, host: p.host }),
  'v2ray-plugin': (p) => ({
    mode: p.mode,
    host: p.host,
    path: p.path,
    tls: p.tls,
    mux: p.mux,
    'skip-cert-verify': p.skipCertVerify,
    headers: p.headers,
  }),
}

/**
 * IR 节点 → mihomo 节点。字段顺序：公共字段、协议字段、插件 / obfs、udp / tfo、TLS、传输层，
 * 最后合并 extra（IR 字段优先）。
 */
export function toMihomoProxy(
  p: ProxyNode,
  defaultUdp: boolean,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const src = p as Record<string, unknown>
  const out: Record<string, unknown> = {
    name: p.name,
    type: p.type,
    server: p.server,
    port: p.port,
  }
  for (const field of PROTOCOL_FIELDS[p.type]) {
    const v = src[field.to]
    if (v !== undefined) out[field.from] = field.kind === 'bandwidth' ? bandwidth(v) : v
  }
  if (p.type === 'ss' && p.plugin) {
    const plugin = p.plugin
    const opts = (SS_PLUGIN[plugin.type] as (p: SsPlugin) => Record<string, unknown>)(plugin)
    out.plugin = plugin.type
    out['plugin-opts'] = compact(opts)
  }
  if (p.type === 'hysteria2' && p.obfs) {
    out.obfs = p.obfs.type
    out['obfs-password'] = p.obfs.password
  }
  out.udp = p.udp ?? defaultUdp
  out.tfo = p.tfo
  if ('tls' in p && p.tls) Object.assign(out, tlsFields(p.type, p.tls))
  if ('transport' in p && p.transport) Object.assign(out, transportFields(p.transport))
  return mergeExtra(compact(out) ?? {}, extra)
}
