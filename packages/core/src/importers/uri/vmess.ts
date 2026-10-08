import type { ProxyOf, TlsOptions, Transport } from '../../ir/index.js'
import { decodeBase64, extraOf, ImportError, invalid, isRecord, Reader } from '../util.js'
import { nameOr } from './link.js'

type Vmess = ProxyOf<'vmess'>

const splitList = (s: string | undefined) => {
  const items = s
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return items?.length ? items : undefined
}

/** v2rayN 格式：vmess://base64(JSON) */
export function parseVmess(rest: string): Vmess {
  const decoded = decodeBase64(rest)
  if (decoded === null) throw invalid('payload is not valid base64')
  let json: unknown
  try {
    json = JSON.parse(decoded)
  } catch {
    throw invalid('payload is not valid JSON')
  }
  if (!isRecord(json)) throw invalid('payload is not a JSON object')

  const r = new Reader(json)
  r.consume('v')
  const name = r.str('ps')?.trim() || undefined
  const server = r.requiredStr('add')
  const port = r.port('port')
  const uuid = r.requiredStr('id')
  const alterId = r.int('aid') ?? 0
  if (alterId < 0) throw invalid('"aid" must not be negative')

  return {
    name: nameOr(name, server, port),
    type: 'vmess',
    server,
    port,
    uuid,
    alterId,
    cipher: r.str('scy') ?? 'auto',
    tls: readTls(r),
    transport: readTransport(r),
    extra: extraOf('uri', r.rest()),
  }
}

function readTls(r: Reader): TlsOptions | undefined {
  const mode = r.str('tls')?.toLowerCase()
  if (mode === undefined || mode === 'none') return undefined
  if (mode !== 'tls') throw invalid('"tls" must be "tls" or empty')
  return {
    sni: r.str('sni'),
    alpn: r.list('alpn'),
    skipCertVerify: r.bool('allowInsecure'),
    clientFingerprint: r.str('fp'),
  }
}

function readTransport(r: Reader): Transport | undefined {
  const net = (r.str('net') ?? 'tcp').toLowerCase()
  const header = r.peek('type')
  // type 为默认值时直接消费；其他值保留到 extra
  const consumeHeader = (...defaults: string[]) => {
    if (typeof header === 'string' && defaults.includes(header)) r.consume('type')
  }
  switch (net) {
    case 'tcp':
      if (header === 'http') {
        r.consume('type')
        return { type: 'http', path: splitList(r.str('path')), host: splitList(r.str('host')) }
      }
      consumeHeader('none')
      return undefined
    case 'ws':
      consumeHeader('none')
      return { type: 'ws', path: r.str('path'), host: r.str('host') }
    case 'httpupgrade':
      consumeHeader('none')
      return { type: 'httpupgrade', path: r.str('path'), host: r.str('host') }
    case 'grpc':
      consumeHeader('gun', 'none')
      return { type: 'grpc', serviceName: r.str('path') }
    case 'h2':
    case 'http':
      consumeHeader('none')
      return { type: 'h2', path: r.str('path'), host: splitList(r.str('host')) }
    default:
      throw new ImportError('UNSUPPORTED_TRANSPORT', `transport "${net}" is not supported`)
  }
}
