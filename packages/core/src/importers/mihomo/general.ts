import { DNS_KEYS, GENERAL_KEYS } from '../../formats/mihomo.js'
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

/** IR 字段的转换。无法转换的值不映射，原样留在 extra。 */
const GENERAL_CONV: Record<(typeof GENERAL_KEYS)[number][1], Conv> = {
  port: port,
  socksPort: port,
  redirPort: port,
  tproxyPort: port,
  mixedPort: port,
  allowLan: bool,
  bindAddress: str,
  mode: lowerEnum('rule', 'global', 'direct'),
  logLevel: lowerEnum('silent', 'error', 'warning', 'info', 'debug'),
  ipv6: bool,
}

const DNS_CONV: Record<(typeof DNS_KEYS)[number][1], Conv> = {
  enable: bool,
  ipv6: bool,
  listen: str,
  enhancedMode: lowerEnum('fake-ip', 'redir-host', 'normal'),
  fakeIpRange: str,
  defaultNameserver: strList,
  nameserver: strList,
  fallback: strList,
}

/** mihomo 键 → [IR 字段, 转换] */
function table<K extends string>(
  keys: ReadonlyArray<readonly [string, K]>,
  conv: Record<K, Conv>,
): Record<string, [string, Conv]> {
  return Object.fromEntries(keys.map(([from, to]) => [from, [to, conv[to]]]))
}

const GENERAL_FIELDS = table(GENERAL_KEYS, GENERAL_CONV)
const DNS_FIELDS = table(DNS_KEYS, DNS_CONV)

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
  // mihomo 的 ipv6 默认为 true，规范化时不能省略 false
  const general = nonEmpty({ ...canonical(mapped), ...(mapped.ipv6 === false && { ipv6: false }) })
  return general ? { general: GeneralConfigSchema.parse(general), rest } : { rest }
}

export function convertDns(src: unknown): DnsConfig | undefined {
  if (!isRecord(src)) return undefined
  const { mapped, rest } = mapFields(src, DNS_FIELDS)
  const dns = nonEmpty(canonical({ ...mapped, extra: extraOf('mihomo', nonEmpty(rest)) }))
  return dns && DnsConfigSchema.parse(dns)
}
