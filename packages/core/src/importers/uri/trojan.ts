import type { ProxyOf } from '../../ir/index.js'
import { extraOf, invalid, safeDecodeURIComponent } from '../util.js'
import { nameOr, parseLink, requiredPort } from './link.js'
import { readTls, readTransport } from './stream.js'

type Trojan = ProxyOf<'trojan'>

/** trojan://password@host:port?sni=...&type=ws&...#name，TLS 始终开启 */
export function parseTrojan(rest: string): Trojan {
  const link = parseLink(rest)
  const password = link.userinfo === undefined ? '' : safeDecodeURIComponent(link.userinfo)
  if (!password) throw invalid('missing password')
  const port = requiredPort(link.portRaw)
  const p = link.params

  const security = (p.str('security') ?? 'tls').toLowerCase()
  if (security !== 'tls' && security !== 'reality')
    throw invalid('"security" must be tls or reality')
  return {
    name: nameOr(link.name, link.host, port),
    type: 'trojan',
    server: link.host,
    port,
    password,
    tls: readTls(p, security),
    transport: readTransport(p),
    extra: extraOf('uri', p.rest()),
  }
}
