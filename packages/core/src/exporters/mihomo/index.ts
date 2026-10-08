import { DNS_KEYS, GENERAL_KEYS, NO_RESOLVE, SRC } from '../../formats/mihomo.js'
import {
  LOGICAL_RULE_TYPES,
  type Profile,
  type ProxyGroup,
  ProxyGroupTypeSchema,
  type ProxyNode,
  ProxyTypeSchema,
  type Rule,
  type RuleCondition,
  RuleTypeSchema,
} from '../../ir/index.js'
import type {
  Capabilities,
  CompatWarning,
  Exporter,
  ExportOptions,
  ExportResult,
} from '../types.js'
import { compact, extraFor, isRecord, mergeExtra } from '../util.js'
import { toMihomoProxy } from './proxy.js'
import { stringifyYaml } from './yaml.js'

export const MIHOMO_CAPABILITIES: Capabilities = {
  proxyTypes: [...ProxyTypeSchema.options],
  groupTypes: [...ProxyGroupTypeSchema.options],
  ruleTypes: [...RuleTypeSchema.options],
  logicalRules: true,
  ruleSetFormats: ['yaml', 'text', 'mrs'],
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

class Context {
  readonly warnings: CompatWarning[] = []

  warn(
    code: CompatWarning['code'],
    path: string,
    action: CompatWarning['action'],
    message: string,
  ) {
    this.warnings.push({ level: 'warn', path, code, message, action })
  }

  extra(extra: ProxyNode['extra'], path: string) {
    return extraFor('mihomo', extra, path, this.warnings)
  }
}

/**
 * 节点改名：同名节点（含与组名、内置目标同名）中，第一个保留原名（与组名或内置目标冲突时也改名），
 * 其余改为「名称 2」「名称 3」……，跳过所有已被占用的名称。
 * 返回最终名称列表，以及原名 → 第一个同名节点最终名称的映射（供组成员和规则引用）。
 */
function assignNames(
  entries: Array<{ node: ProxyNode; path: string }>,
  groups: Set<string>,
  ctx: Context,
) {
  const reserved = new Set([...groups, ...BUILTIN_TARGETS, ...entries.map((e) => e.node.name)])
  const used = new Set<string>()
  const firstName = new Map<string, string>()
  const names = entries.map(({ node, path }) => {
    const original = node.name
    let name = original
    if (used.has(name) || groups.has(name) || BUILTIN_TARGETS.has(name)) {
      let n = 2
      while (reserved.has(`${original} ${n}`) || used.has(`${original} ${n}`)) n++
      name = `${original} ${n}`
      ctx.warn(
        'DUPLICATE_PROXY_NAME',
        path,
        'kept',
        'renamed because the name is already used by another proxy, a group or a built-in target',
      )
    }
    used.add(name)
    if (!firstName.has(original)) firstName.set(original, name)
    return name
  })
  return { names, firstName }
}

function uniqueGroups(groups: ProxyGroup[], ctx: Context) {
  const seen = new Set<string>()
  const kept: Array<{ group: ProxyGroup; path: string }> = []
  groups.forEach((group, i) => {
    const path = `groups[${i}]`
    if (seen.has(group.name)) {
      ctx.warn('DUPLICATE_GROUP_NAME', path, 'dropped', 'a group with the same name already exists')
      return
    }
    seen.add(group.name)
    kept.push({ group, path })
  })
  return kept
}

function convertGroup(
  group: ProxyGroup,
  path: string,
  groupNames: ReadonlySet<string>,
  proxyName: ReadonlyMap<string, string>,
  ctx: Context,
): Record<string, unknown> {
  const proxies: string[] = []
  group.members.forEach((m, j) => {
    const name =
      m.kind === 'builtin'
        ? m.name
        : m.kind === 'group'
          ? groupNames.has(m.name)
            ? m.name
            : undefined
          : proxyName.get(m.name)
    if (name === undefined) {
      ctx.warn(
        'UNKNOWN_GROUP_MEMBER',
        `${path}.members[${j}]`,
        'dropped',
        `the ${m.kind} referenced by this member does not exist`,
      )
    } else {
      proxies.push(name)
    }
  })
  const extra = ctx.extra(group.extra, path)
  const autoMembers = group.includeAllProxies || AUTO_MEMBER_KEYS.some((k) => extra?.[k])
  if (!proxies.length && !autoMembers) {
    proxies.push('DIRECT')
    ctx.warn('EMPTY_GROUP', path, 'downgraded', 'the group has no members left; DIRECT was added')
  }
  const out = compact({
    name: group.name,
    type: group.type,
    proxies: proxies.length ? proxies : undefined,
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

function convertRuleProviders(profile: Profile, ctx: Context) {
  const providers: Record<string, unknown> = {}
  profile.ruleSets.forEach((set, i) => {
    const path = `ruleSets[${i}]`
    const source = set.sources.mihomo
    if (!source) {
      ctx.warn('RULE_SET_NO_SOURCE', path, 'dropped', 'the rule set has no mihomo source')
      return
    }
    if (source.format === 'list' || (source.format === 'mrs' && set.behavior === 'classical')) {
      ctx.warn(
        'UNSUPPORTED_RULE_SET_FORMAT',
        path,
        'dropped',
        `mihomo does not support the ${source.format} format with ${set.behavior} behavior`,
      )
      return
    }
    const provider = compact({
      type: 'http',
      behavior: set.behavior,
      format: source.format,
      url: source.url,
      interval: set.interval,
    })
    providers[set.id] = mergeExtra(provider ?? {}, ctx.extra(set.extra, path))
  })
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

function ruleSetIds(c: RuleCondition): string[] {
  if (c.type === 'RULE-SET' && c.value !== undefined) return [c.value]
  return (c.children ?? []).flatMap(ruleSetIds)
}

function convertRules(
  rules: Rule[],
  ruleSets: ReadonlySet<string>,
  groupNames: ReadonlySet<string>,
  proxyName: ReadonlyMap<string, string>,
  ctx: Context,
): string[] {
  const out: string[] = []
  rules.forEach((rule, i) => {
    const path = `rules[${i}]`
    if (ruleSetIds(rule).some((id) => !ruleSets.has(id))) {
      ctx.warn(
        'UNKNOWN_RULE_SET',
        path,
        'dropped',
        'the rule references a rule set that does not exist or cannot be exported',
      )
      return
    }
    const target =
      groupNames.has(rule.target) || BUILTIN_TARGETS.has(rule.target)
        ? rule.target
        : proxyName.get(rule.target)
    if (target === undefined) {
      ctx.warn('UNKNOWN_RULE_TARGET', path, 'dropped', 'the rule target does not exist')
      return
    }
    out.push(formatRule(rule, target))
  })
  return out
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
  const ctx = new Context()
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

  // 节点
  const groups = uniqueGroups(profile.groups, ctx)
  const groupNames = new Set(groups.map((g) => g.group.name))
  const entries = [
    ...profile.proxies.map((node, i) => ({ node, path: `proxies[${i}]` })),
    ...nodes.map((node, i) => ({ node, path: `nodes[${i}]` })),
  ]
  const { names, firstName } = assignNames(entries, groupNames, ctx)
  const proxies = entries.map(({ node, path }, i) => ({
    ...toMihomoProxy(node, defaultUdp, ctx.extra(node.extra, path)),
    name: names[i],
  }))

  const proxyGroups = groups.map(({ group, path }) =>
    convertGroup(group, path, groupNames, firstName, ctx),
  )
  const providers = convertRuleProviders(profile, ctx)
  const rules = convertRules(
    profile.rules,
    new Set(Object.keys(providers)),
    groupNames,
    firstName,
    ctx,
  )

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
