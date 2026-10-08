import type { TlsOptions, Transport } from '../../ir/index.js'
import { ImportError, invalid, type Reader } from '../util.js'

/** vless / trojan 等 Xray 风格链接的 TLS 参数 */
export function readTls(p: Reader, security: 'tls' | 'reality'): TlsOptions {
  // 别名都要读取，避免未用到的那个进入 extra
  const sni = p.str('sni')
  const peer = p.str('peer')
  const allowInsecure = p.bool('allowInsecure')
  const insecure = p.bool('insecure')
  const tls: TlsOptions = {
    sni: sni ?? peer,
    alpn: p.list('alpn'),
    skipCertVerify: allowInsecure || insecure,
    clientFingerprint: p.str('fp'),
  }
  if (security === 'reality') {
    const publicKey = p.str('pbk')
    if (!publicKey) throw invalid('reality requires "pbk"')
    tls.reality = { publicKey, shortId: p.str('sid') }
  }
  return tls
}

const splitList = (s: string | undefined) => {
  const items = s
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return items?.length ? items : undefined
}

/** vless / trojan 等 Xray 风格链接的传输层参数（type、host、path、serviceName 等） */
export function readTransport(p: Reader): Transport | undefined {
  const type = (p.str('type') ?? 'tcp').toLowerCase()
  switch (type) {
    case 'tcp':
    case 'raw': {
      const header = p.peek('headerType')
      if (header === 'http') {
        p.consume('headerType')
        return { type: 'http', path: splitList(p.str('path')), host: splitList(p.str('host')) }
      }
      if (header === 'none') p.consume('headerType')
      return undefined
    }
    case 'ws':
      return { type: 'ws', path: p.str('path'), host: p.str('host') }
    case 'httpupgrade':
      return { type: 'httpupgrade', path: p.str('path'), host: p.str('host') }
    case 'grpc': {
      const mode = p.peek('mode')
      if (mode === 'gun') p.consume('mode')
      return { type: 'grpc', serviceName: p.str('serviceName') }
    }
    case 'h2':
    case 'http':
      return { type: 'h2', path: p.str('path'), host: splitList(p.str('host')) }
    default:
      throw new ImportError('UNSUPPORTED_TRANSPORT', `transport "${type}" is not supported`)
  }
}
