import type { ProxyOf, SsPlugin } from '../../ir/index.js'
import { decodeBase64, extraOf, invalid, Reader, safeDecodeURIComponent } from '../util.js'
import { type Link, nameOr, parseLink, requiredPort, splitHostPort } from './link.js'

type Ss = ProxyOf<'ss'>

/**
 * SIP002：ss://base64url(method:password)@host:port/?plugin=...#name
 *        ss://method:password@host:port（2022 系列加密使用百分号编码的明文）
 * 旧格式：ss://base64(method:password@host:port)#name
 */
export function parseSs(rest: string): Ss {
  const beforeQuery = rest.split(/[?#]/, 1)[0] ?? ''
  const { link, credentials } = beforeQuery.includes('@') ? parseSip002(rest) : parseLegacy(rest)
  const colon = credentials.indexOf(':')
  if (colon < 0) throw invalid('missing password')
  const cipher = credentials.slice(0, colon)
  if (!cipher) throw invalid('missing cipher')

  const port = requiredPort(link.portRaw)
  const p = link.params
  const plugin = readPlugin(p)
  return {
    name: nameOr(link.name, link.host, port),
    type: 'ss',
    server: link.host,
    port,
    cipher,
    password: credentials.slice(colon + 1),
    plugin: plugin.plugin,
    extra: extraOf('uri', { ...plugin.extra, ...p.rest() }),
  }
}

function parseSip002(rest: string): { link: Link; credentials: string } {
  const link = parseLink(rest)
  const decoded = safeDecodeURIComponent(link.userinfo ?? '')
  // base64 不含冒号，所以含冒号的一定是明文
  const credentials = decoded.includes(':') ? decoded : decodeBase64(decoded)
  if (credentials === null) throw invalid('credentials are neither base64 nor plain text')
  return { link, credentials }
}

function parseLegacy(rest: string): { link: Link; credentials: string } {
  // 只有 base64 主体，query 和 #name 照常解析
  const bodyEnd = rest.search(/[?#]/)
  const body = (bodyEnd < 0 ? rest : rest.slice(0, bodyEnd)).replace(/\/$/, '')
  const decoded = decodeBase64(safeDecodeURIComponent(body))
  if (decoded === null) throw invalid('legacy link body is not base64')
  const at = decoded.lastIndexOf('@')
  if (at < 0) throw invalid('legacy link body has no "@"')
  const link: Link = {
    ...parseLink(`placeholder${bodyEnd < 0 ? '' : rest.slice(bodyEnd)}`),
    ...splitHostPort(decoded.slice(at + 1)),
  }
  return { link, credentials: decoded.slice(0, at) }
}

/** SIP003 插件参数：name;key=value;flag */
function readPlugin(p: Reader): { plugin?: SsPlugin; extra?: Record<string, unknown> } {
  const raw = p.str('plugin')
  if (raw === undefined) return {}
  const [name = '', ...parts] = raw.split(';')
  const opts: Record<string, string | true> = {}
  for (const part of parts) {
    if (!part) continue
    const eq = part.indexOf('=')
    opts[eq < 0 ? part : part.slice(0, eq)] = eq < 0 ? true : part.slice(eq + 1)
  }
  const o = new Reader(opts)
  let plugin: SsPlugin
  switch (name.trim()) {
    case 'obfs-local':
    case 'simple-obfs': {
      const mode = o.str('obfs')
      if (mode !== 'http' && mode !== 'tls')
        throw invalid('obfs plugin requires obfs=http or obfs=tls')
      plugin = { type: 'obfs', mode, host: o.str('obfs-host') }
      break
    }
    case 'v2ray-plugin': {
      const mode = o.peek('mode') ?? 'websocket'
      if (mode !== 'websocket') return { extra: { plugin: raw } }
      o.consume('mode')
      plugin = {
        type: 'v2ray-plugin',
        mode,
        host: o.str('host'),
        path: o.str('path'),
        tls: o.has('tls'),
      }
      o.consume('tls')
      break
    }
    default:
      return { extra: { plugin: raw } }
  }
  const leftover = o.rest()
  return leftover ? { plugin, extra: { 'plugin-opts': leftover } } : { plugin }
}
