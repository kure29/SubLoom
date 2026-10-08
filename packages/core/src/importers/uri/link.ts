import { hostPort, invalid, parsePort, Reader, safeDecodeURIComponent } from '../util.js'

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/s

/** 拆出协议名（小写）和 :// 之后的部分 */
export function splitScheme(uri: string): { scheme: string; rest: string } | null {
  const m = SCHEME_RE.exec(uri)
  return m?.[1] && m[2] !== undefined ? { scheme: m[1].toLowerCase(), rest: m[2] } : null
}

export interface Link {
  /** 未解码的 userinfo */
  userinfo?: string
  host: string
  /** 未解析的端口部分，可能是范围 */
  portRaw?: string
  path: string
  /** 已解码的查询参数 */
  params: Reader
  /** 已解码的 #name */
  name?: string
}

/** 不用 URLSearchParams：它会把 + 解码成空格，而密码等参数中的 + 需要保留 */
export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = safeDecodeURIComponent(eq < 0 ? part : part.slice(0, eq))
    out[key] = eq < 0 ? '' : safeDecodeURIComponent(part.slice(eq + 1))
  }
  return out
}

export function splitHostPort(hostport: string): { host: string; portRaw?: string } {
  let host: string
  let portRaw: string | undefined
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']')
    if (close < 0) throw invalid('unterminated IPv6 address')
    host = hostport.slice(1, close)
    const after = hostport.slice(close + 1)
    if (after.startsWith(':')) portRaw = after.slice(1)
    else if (after) throw invalid('unexpected characters after the host')
  } else {
    const colon = hostport.indexOf(':')
    host = colon < 0 ? hostport : hostport.slice(0, colon)
    portRaw = colon < 0 ? undefined : hostport.slice(colon + 1)
  }
  if (!host) throw invalid('missing host')
  return portRaw === undefined ? { host } : { host, portRaw }
}

/** 解析 userinfo@host:port/path?query#name */
export function parseLink(rest: string): Link {
  let s = rest
  let name: string | undefined
  const hash = s.indexOf('#')
  if (hash >= 0) {
    name = safeDecodeURIComponent(s.slice(hash + 1)).trim() || undefined
    s = s.slice(0, hash)
  }
  let query = ''
  const q = s.indexOf('?')
  if (q >= 0) {
    query = s.slice(q + 1)
    s = s.slice(0, q)
  }
  const slash = s.indexOf('/')
  const path = slash < 0 ? '' : s.slice(slash)
  const authority = slash < 0 ? s : s.slice(0, slash)
  const at = authority.lastIndexOf('@')
  const userinfo = at < 0 ? undefined : authority.slice(0, at)
  const link: Link = {
    ...splitHostPort(at < 0 ? authority : authority.slice(at + 1)),
    path,
    params: new Reader(parseQuery(query)),
  }
  if (userinfo !== undefined) link.userinfo = userinfo
  if (name !== undefined) link.name = name
  return link
}

export const nameOr = (name: string | undefined, server: string, port: number) =>
  name ?? hostPort(server, port)

export function requiredPort(portRaw: string | undefined): number {
  if (portRaw === undefined) throw invalid('missing port')
  return parsePort(portRaw)
}
