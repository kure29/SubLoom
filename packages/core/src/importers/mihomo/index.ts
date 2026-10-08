import { type ProxyNode, ProxySchema } from '../../ir/index.js'
import type { ImportedConfig, ImportResult, ImportWarning } from '../types.js'
import { canonical, describeIssues, extraOf, ImportError, isRecord } from '../util.js'
import { convertDns, convertGeneral } from './general.js'
import { convertGroups } from './group.js'
import { convertProxy } from './proxy.js'
import { convertRules } from './rule.js'
import { convertRuleProviders } from './rule-provider.js'
import { parseYaml } from './yaml.js'

const fatal = (message: string): ImportResult => ({
  format: 'mihomo-yaml',
  proxies: [],
  warnings: [{ level: 'error', code: 'INVALID_YAML', message }],
})

/** 单独处理的顶层键，其余进入 general 或 extra */
const STRUCTURAL_KEYS = new Set(['proxies', 'proxy-groups', 'rules', 'rule-providers', 'dns'])

function convertProxies(list: unknown[], warnings: ImportWarning[]): ProxyNode[] {
  const proxies: ProxyNode[] = []
  list.forEach((item, i) => {
    const path = `proxies[${i}]`
    const type = isRecord(item) && typeof item.type === 'string' ? item.type : undefined
    const warn = (code: ImportWarning['code'], message: string) =>
      warnings.push({
        level: 'warn',
        code,
        ...(type === undefined ? {} : { protocol: type }),
        path,
        message,
      })
    try {
      const parsed = ProxySchema.safeParse(canonical(convertProxy(item)))
      if (parsed.success) proxies.push(parsed.data)
      else warn('INVALID_PROXY', `invalid proxy: ${describeIssues(parsed.error)}`)
    } catch (e) {
      if (!(e instanceof ImportError)) throw e
      warn(e.code, e.code === 'INVALID_PROXY' ? `invalid proxy: ${e.message}` : e.message)
    }
  })
  return proxies
}

/** 导入 mihomo（Clash.Meta）YAML：完整配置或只有 proxies 的 provider 响应 */
export function importMihomoYaml(text: string): ImportResult {
  const parsed = parseYaml(text)
  if (!parsed.ok)
    return fatal(parsed.line === undefined ? 'invalid YAML' : `invalid YAML at line ${parsed.line}`)
  const doc = parsed.value
  if (!isRecord(doc)) return fatal('top level must be a mapping')
  const list = doc.proxies ?? []
  if (!Array.isArray(list)) return fatal('"proxies" must be a list')

  const warnings: ImportWarning[] = []
  const proxies = convertProxies(list, warnings)
  const result: ImportResult = { format: 'mihomo-yaml', proxies, warnings }
  if (Object.keys(doc).every((k) => k === 'proxies')) return result

  const others: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) if (!STRUCTURAL_KEYS.has(k)) others[k] = v
  const { general, rest } = convertGeneral(others)
  const dns = convertDns(doc.dns)
  if (doc.dns !== undefined && dns === undefined) rest.dns = doc.dns

  const groups = convertGroups(doc['proxy-groups'], new Set(proxies.map((p) => p.name)), warnings)
  const ruleSets = convertRuleProviders(doc['rule-providers'], warnings)
  const rules = convertRules(doc.rules, warnings)
  const extra = extraOf('mihomo', Object.keys(rest).length ? rest : undefined)
  // 各部分已是规范形式，这里只去掉缺省的部分（再次规范化会丢掉 general.ipv6: false）
  const config: ImportedConfig = {
    ...(general && { general }),
    ...(dns && { dns }),
    groups,
    ruleSets,
    rules,
    ...(extra && { extra }),
  }
  // 警告在 config 之后输出，保持 { format, proxies, config, warnings } 的顺序
  return { format: 'mihomo-yaml', proxies, config, warnings }
}
