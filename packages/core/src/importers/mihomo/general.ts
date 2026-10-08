import {
  type DnsConfig,
  DnsConfigSchema,
  type GeneralConfig,
  GeneralConfigSchema,
} from '../../ir/index.js'
import { canonical, extraOf, isRecord, parsePort } from '../util.js'

type Conv = (v: unknown) => unknown

const port: Conv = (v) => parsePort(typeof v === 'number' ? v : String(v))
const bool: Conv = (v) => {
  if (typeof v !== 'boolean') throw new Error('not a boolean')
  return v
}
const str: Conv = (v) => {
  if (typeof v !== 'string' || !v) throw new Error('not a string')
  return v
}
const lowerEnum =
  (...values: string[]): Conv =>
  (v) => {
    const s = String(v).toLowerCase()
    if (!values.includes(s)) throw new Error('unknown value')
    return s
  }
const strList: Conv = (v) => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error('not a list')
  return v
}

/** mihomo 键 → [IR 字段, 转换]。无法转换的值不映射，原样留在 extra。 */
const GENERAL_FIELDS: Record<string, [string, Conv]> = {
  port: ['port', port],
  'socks-port': ['socksPort', port],
  'redir-port': ['redirPort', port],
  'tproxy-port': ['tproxyPort', port],
  'mixed-port': ['mixedPort', port],
  'allow-lan': ['allowLan', bool],
  'bind-address': ['bindAddress', str],
  mode: ['mode', lowerEnum('rule', 'global', 'direct')],
  'log-level': ['logLevel', lowerEnum('silent', 'error', 'warning', 'info', 'debug')],
  ipv6: ['ipv6', bool],
}

const DNS_FIELDS: Record<string, [string, Conv]> = {
  enable: ['enable', bool],
  ipv6: ['ipv6', bool],
  listen: ['listen', str],
  'enhanced-mode': ['enhancedMode', lowerEnum('fake-ip', 'redir-host', 'normal')],
  'fake-ip-range': ['fakeIpRange', str],
  'default-nameserver': ['defaultNameserver', strList],
  nameserver: ['nameserver', strList],
  fallback: ['fallback', strList],
}

/** 按字段表映射，返回映射结果和未映射的键 */
function mapFields(src: Record<string, unknown>, table: Record<string, [string, Conv]>) {
  const mapped: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(src)) {
    const spec = Object.hasOwn(table, key) ? table[key] : undefined
    if (spec && value !== null && value !== undefined) {
      try {
        mapped[spec[0]] = spec[1](value)
        continue
      } catch {
        // 落入 rest
      }
    }
    if (value !== null && value !== undefined) rest[key] = value
  }
  return { mapped, rest }
}

const nonEmpty = (o: Record<string, unknown>) => (Object.keys(o).length ? o : undefined)

/** 顶层通用字段；返回剩余的顶层键 */
export function convertGeneral(top: Record<string, unknown>): {
  general?: GeneralConfig
  rest: Record<string, unknown>
} {
  const { mapped, rest } = mapFields(top, GENERAL_FIELDS)
  const general = nonEmpty(canonical(mapped))
  return general ? { general: GeneralConfigSchema.parse(general), rest } : { rest }
}

export function convertDns(src: unknown): DnsConfig | undefined {
  if (!isRecord(src)) return undefined
  const { mapped, rest } = mapFields(src, DNS_FIELDS)
  const dns = nonEmpty(canonical({ ...mapped, extra: extraOf('mihomo', nonEmpty(rest)) }))
  return dns && DnsConfigSchema.parse(dns)
}
