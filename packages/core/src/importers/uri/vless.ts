import type { ProxyOf } from '../../ir/index.js'
import { extraOf, invalid, safeDecodeURIComponent } from '../util.js'
import { nameOr, parseLink, requiredPort } from './link.js'
import { readTls, readTransport } from './stream.js'

type Vless = ProxyOf<'vless'>

/** vless://uuid@host:port?security=reality&type=grpc&...#name */
export function parseVless(rest: string): Vless {
  const link = parseLink(rest)
  const uuid = link.userinfo === undefined ? '' : safeDecodeURIComponent(link.userinfo)
  if (!uuid) throw invalid('missing uuid')
  const port = requiredPort(link.portRaw)
  const p = link.params

  const encryption = p.peek('encryption')
  if (encryption === 'none') p.consume('encryption')

  const security = (p.str('security') ?? 'none').toLowerCase()
  if (security !== 'none' && security !== 'tls' && security !== 'reality') {
    throw invalid('"security" must be none, tls or reality')
  }
  return {
    name: nameOr(link.name, link.host, port),
    type: 'vless',
    server: link.host,
    port,
    uuid,
    flow: p.str('flow'),
    tls: security === 'none' ? undefined : readTls(p, security),
    transport: readTransport(p),
    extra: extraOf('uri', p.rest()),
  }
}
