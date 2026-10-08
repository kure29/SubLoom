import { type ProxyNode, ProxySchema } from '../../ir/index.js'
import type { ImportFormat, ImportResult, ImportWarning, ImportWarningCode } from '../types.js'
import { canonical, describeIssues, ImportError } from '../util.js'
import { parseHysteria2 } from './hysteria2.js'
import { splitScheme } from './link.js'
import { parseSs } from './ss.js'
import { parseTrojan } from './trojan.js'
import { parseVless } from './vless.js'
import { parseVmess } from './vmess.js'

/** 支持的 URI 协议。hy2 是 hysteria2 的别名。 */
const PARSERS = new Map<string, { protocol: string; parse: (rest: string) => ProxyNode }>([
  ['ss', { protocol: 'ss', parse: parseSs }],
  ['vmess', { protocol: 'vmess', parse: parseVmess }],
  ['vless', { protocol: 'vless', parse: parseVless }],
  ['trojan', { protocol: 'trojan', parse: parseTrojan }],
  ['hysteria2', { protocol: 'hysteria2', parse: parseHysteria2 }],
  ['hy2', { protocol: 'hysteria2', parse: parseHysteria2 }],
])

export type UriParseResult =
  | { ok: true; proxy: ProxyNode }
  | { ok: false; code: ImportWarningCode; protocol?: string; message: string }

/** 解析单个代理链接 */
export function parseProxyUri(uri: string): UriParseResult {
  const split = splitScheme(uri.trim())
  if (!split) return { ok: false, code: 'INVALID_URI', message: 'not a proxy link' }
  const parser = PARSERS.get(split.scheme)
  if (!parser) {
    return {
      ok: false,
      code: 'UNSUPPORTED_PROTOCOL',
      protocol: split.scheme,
      message: `protocol "${split.scheme}" is not supported`,
    }
  }
  const { protocol } = parser
  try {
    const result = ProxySchema.safeParse(canonical(parser.parse(split.rest)))
    if (!result.success) {
      return {
        ok: false,
        code: 'INVALID_PROXY',
        protocol,
        message: `invalid ${protocol} link: ${describeIssues(result.error)}`,
      }
    }
    return { ok: true, proxy: result.data }
  } catch (e) {
    if (!(e instanceof ImportError)) throw e
    return { ok: false, code: e.code, protocol, message: `invalid ${protocol} link: ${e.message}` }
  }
}

/** 逐行解析代理链接列表，跳过空行，非法行产生带行号的警告 */
export function importUriList(text: string, format: ImportFormat = 'uri-list'): ImportResult {
  const proxies: ProxyNode[] = []
  const warnings: ImportWarning[] = []
  text.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line) return
    const r = parseProxyUri(line)
    if (r.ok) {
      proxies.push(r.proxy)
      return
    }
    warnings.push({
      level: 'warn',
      code: r.code,
      ...(r.protocol === undefined ? {} : { protocol: r.protocol }),
      line: i + 1,
      message: r.message,
    })
  })
  return { format, proxies, warnings }
}
