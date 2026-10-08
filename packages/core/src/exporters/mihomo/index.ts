import { DNS_KEYS, GENERAL_KEYS, NO_RESOLVE, SRC } from '../../formats/mihomo.js'
import {
  LOGICAL_RULE_TYPES,
  type Profile,
  ProxyGroupTypeSchema,
  type ProxyNode,
  ProxyTypeSchema,
  type RuleCondition,
  RuleTypeSchema,
} from '../../ir/index.js'
import {
  ExportContext,
  type ResolvedGroup,
  type ResolvedProfile,
  resolveProfile,
  type TargetSpec,
} from '../resolve.js'
import type { Capabilities, Exporter, ExportOptions, ExportResult } from '../types.js'
import { compact, isRecord, mergeExtra } from '../util.js'
import { toMihomoProxy } from './proxy.js'
import { stringifyYaml } from './yaml.js'

export const MIHOMO_CAPABILITIES: Capabilities = {
  proxyTypes: [...ProxyTypeSchema.options],
  groupTypes: [...ProxyGroupTypeSchema.options],
  ruleTypes: [...RuleTypeSchema.options],
  logicalRules: true,
  ruleSetFormats: ['yaml', 'text', 'mrs'],
  // rule-providers 的 proxy 字段（mihomo 源码 rules/provider/parse.go 中的 ruleProviderSchema.Proxy）
  ruleSetProxy: true,
}

/** mihomo 的内置出站，可以作为规则目标和组成员 */
const BUILTIN_TARGETS: ReadonlySet<string> = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'COMPATIBLE',
])

/** 这些键说明组会自动获得成员，不需要 proxies */
const AUTO_MEMBER_KEYS = ['use', 'include-all', 'include-all-proxies', 'include-all-providers']

export const MIHOMO_SPEC: TargetSpec = {
  target: 'mihomo',
  capabilities: MIHOMO_CAPABILITIES,
  builtins: BUILTIN_TARGETS,
  hasAutoMembers: (extra) => AUTO_MEMBER_KEYS.some((k) => extra?.[k]),
  ruleSetSource(set) {
    const source = set.sources.mihomo
    if (!source) return { code: 'RULE_SET_NO_SOURCE', message: 'the rule set has no mihomo source' }
    if (source.format === 'list' || (source.format === 'mrs' && set.behavior === 'classical')) {
      return {
        code: 'UNSUPPORTED_RULE_SET_FORMAT',
        message: `mihomo does not support the ${source.format} format with ${set.behavior} behavior`,
      }
    }
    return source
  },
}

function convertGroup({ group, type, members, extra }: ResolvedGroup): Record<string, unknown> {
  const out = compact({
    name: group.name,
    type,
    proxies: members.length ? members : undefined,
    'include-all-proxies': group.includeAllProxies,
    filter: group.filter?.include,
    'exclude-filter': group.filter?.exclude,
    url: group.testUrl,
    interval: group.interval,
    tolerance: group.tolerance,
    hidden: group.hidden,
    icon: group.icon,
  })
  return mergeExtra(out ?? {}, extra)
}

function convertRuleProviders(resolved: ResolvedProfile, ctx: ExportContext) {
  const providers: Record<string, unknown> = {}
  for (const { set, path, source, extra } of resolved.ruleSets.values()) {
    // 下载策略由导出选项统一决定，覆盖导入时保留下来的 proxy
    if (extra?.proxy !== undefined && extra.proxy !== resolved.ruleSetPolicy) {
      ctx.warn(
        'EXTRA_IGNORED',
        `${path}.extra.mihomo.proxy`,
        'dropped',
        'the download policy of rule sets is set by the ruleSetPolicy export option',
        'info',
      )
    }
    const provider = compact({
      type: 'http',
      behavior: set.behavior,
      format: source.format,
      url: source.url,
      proxy: resolved.ruleSetPolicy,
      interval: set.interval,
    })
    providers[set.id] = mergeExtra(provider ?? {}, extra)
  }
  return providers
}

const params = (c: RuleCondition) => [c.src && SRC, c.noResolve && NO_RESOLVE].filter(Boolean)

/** TYPE,value[,target][,src][,no-resolve]；逻辑规则为 TYPE,((子条件),(子条件)) */
function formatRule(c: RuleCondition, target?: string): string {
  const head = LOGICAL_RULE_TYPES.has(c.type)
    ? [c.type, `(${(c.children ?? []).map((child) => `(${formatRule(child)})`).join(',')})`]
    : [c.type, ...(c.value === undefined ? [] : [c.value])]
  return [...head, ...(target === undefined ? [] : [target]), ...params(c)].join(',')
}

function mapKeys(
  src: Record<string, unknown>,
  keys: ReadonlyArray<readonly [string, string]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [to, from] of keys) if (src[from] !== undefined) out[to] = src[from]
  return out
}

/** 导出 mihomo 配置。nodes 是经过流水线处理的订阅节点，输出在 profile.proxies 之后。 */
export function exportMihomo(
  profile: Profile,
  nodes: readonly ProxyNode[],
  opts: ExportOptions = {},
): ExportResult {
  const ctx = new ExportContext('mihomo')
  const defaultUdp = opts.defaultUdp ?? true

  // 顶层：general → general.extra → profile.extra → dns
  let doc: Record<string, unknown> = {}
  if (profile.general) {
    doc = mergeExtra(
      mapKeys(profile.general, GENERAL_KEYS),
      ctx.extra(profile.general.extra, 'general'),
    )
  }
  doc = mergeExtra(doc, ctx.extra(profile.extra, ''))
  if (profile.dns) {
    const dns = mergeExtra(mapKeys(profile.dns, DNS_KEYS), ctx.extra(profile.dns.extra, 'dns'))
    doc.dns = isRecord(doc.dns) ? mergeExtra(dns, doc.dns) : dns
  }

  const r = resolveProfile(MIHOMO_SPEC, profile, nodes, opts, ctx)
  const proxies = r.proxies.map(({ node, name, extra }) => ({
    ...toMihomoProxy(node, defaultUdp, extra),
    name,
  }))
  const proxyGroups = r.groups.map(convertGroup)
  const providers = convertRuleProviders(r, ctx)
  const rules = r.rules.map(({ rule, target }) => formatRule(rule, target))

  for (const key of ['proxies', 'proxy-groups', 'rule-providers', 'rules']) delete doc[key]
  doc.proxies = proxies
  if (proxyGroups.length) doc['proxy-groups'] = proxyGroups
  if (Object.keys(providers).length) doc['rule-providers'] = providers
  if (rules.length) doc.rules = rules

  return { text: stringifyYaml(doc), warnings: ctx.warnings }
}

export const mihomoExporter: Exporter = {
  target: 'mihomo',
  capabilities: MIHOMO_CAPABILITIES,
  export: exportMihomo,
}
