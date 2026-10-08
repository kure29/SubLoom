import {
  type ExtraSource,
  LOGICAL_RULE_TYPES,
  type Profile,
  type ProxyGroup,
  type ProxyGroupType,
  type ProxyNode,
  type Rule,
  type RuleCondition,
  type RuleSet,
} from '../ir/index.js'
import type {
  Capabilities,
  CompatWarning,
  CompatWarningCode,
  ExportOptions,
  RuleSetMirror,
} from './types.js'
import { extraFor } from './util.js'

/**
 * 与具体客户端无关的导出前处理：按能力矩阵降级、处理名称冲突、清理悬空引用。
 * 各导出器先调用 resolveProfile，再把结果写成自己的格式，保证行为一致。
 */

export class ExportContext {
  readonly warnings: CompatWarning[] = []

  constructor(readonly target: ExtraSource) {}

  warn(
    code: CompatWarningCode,
    path: string,
    action: CompatWarning['action'],
    message: string,
    level: CompatWarning['level'] = 'warn',
  ) {
    this.warnings.push({ level, path, code, message, action })
  }

  /** 取出目标格式的 extra，其余命名空间给出 EXTRA_IGNORED 警告 */
  extra(extra: ProxyNode['extra'], path: string) {
    return extraFor(this.target, extra, path, this.warnings)
  }
}

export type RuleSetSource = NonNullable<RuleSet['sources'][keyof RuleSet['sources']]>

/** 节点子功能检查中的警告；field 为相对节点的路径，如 tls.clientFingerprint */
export type ProxyWarn = (
  code: 'UNSUPPORTED_PROXY_FEATURE',
  field: string,
  action: 'dropped' | 'downgraded',
  message: string,
) => void

export interface TargetSpec {
  target: ExtraSource
  capabilities: Capabilities
  /** 客户端的内置策略，可作为规则目标和组成员 */
  builtins: ReadonlySet<string>
  /** 组的 extra 中是否有让组自动获得成员的设置（如 mihomo 的 use） */
  hasAutoMembers?(extra: Record<string, unknown> | undefined): boolean
  /** 规则集在该客户端的来源；不可用时返回警告 */
  ruleSetSource(
    set: RuleSet,
  ): RuleSetSource | { code: 'RULE_SET_NO_SOURCE' | 'UNSUPPORTED_RULE_SET_FORMAT'; message: string }
  /**
   * 节点子功能检查（类型已确认受支持）：返回 undefined 表示移除节点，
   * 否则返回（可能去掉了某些字段的）节点。每处改动都要调用 warn。
   */
  adaptProxy?(node: ProxyNode, warn: ProxyWarn): ProxyNode | undefined
  /** 规则参数检查：返回不支持的原因，规则会被移除 */
  checkRule?(rule: RuleCondition): string | undefined
}

export interface ResolvedProxy {
  node: ProxyNode
  /** 处理名称冲突后的最终名称 */
  name: string
  path: string
  extra: Record<string, unknown> | undefined
}

export interface ResolvedGroup {
  group: ProxyGroup
  path: string
  /** 降级后的类型 */
  type: ProxyGroupType
  /** 最终的成员名称（节点、组或内置策略） */
  members: string[]
  extra: Record<string, unknown> | undefined
}

export interface ResolvedRuleSet {
  set: RuleSet
  path: string
  /** 已应用镜像的来源 */
  source: RuleSetSource
  extra: Record<string, unknown> | undefined
}

export interface ResolvedRule {
  rule: Rule
  path: string
  /** 最终的目标名称 */
  target: string
}

export interface ResolvedProfile {
  proxies: ResolvedProxy[]
  groups: ResolvedGroup[]
  ruleSets: Map<string, ResolvedRuleSet>
  rules: ResolvedRule[]
  /** 下载规则集用的策略；客户端不支持指定时为 undefined */
  ruleSetPolicy: string | undefined
}

/** 不支持的组类型依次尝试的替代类型 */
const GROUP_FALLBACK: Record<ProxyGroupType, ProxyGroupType[]> = {
  select: [],
  'url-test': ['select'],
  fallback: ['url-test', 'select'],
  'load-balance': ['url-test', 'select'],
}

function uniqueGroups(groups: ProxyGroup[], ctx: ExportContext) {
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

function supportedProxies(
  spec: TargetSpec,
  entries: Array<{ node: ProxyNode; path: string }>,
  ctx: ExportContext,
) {
  const types = new Set(spec.capabilities.proxyTypes)
  const kept: Array<{ node: ProxyNode; path: string }> = []
  for (const { node, path } of entries) {
    if (!types.has(node.type)) {
      ctx.warn(
        'UNSUPPORTED_PROXY_TYPE',
        path,
        'dropped',
        `${spec.target} does not support ${node.type} proxies`,
      )
      continue
    }
    const adapted = spec.adaptProxy
      ? spec.adaptProxy(node, (code, field, action, message) =>
          ctx.warn(code, `${path}.${field}`, action, message),
        )
      : node
    if (adapted) kept.push({ node: adapted, path })
  }
  return kept
}

/**
 * 节点改名：同名节点（含与组名、内置策略同名）中，第一个保留原名（与组名或内置策略冲突时也改名），
 * 其余改为「名称 2」「名称 3」……，跳过所有已被占用的名称。
 * 返回最终名称列表，以及原名 → 第一个同名节点最终名称的映射（供组成员和规则引用）。
 */
function assignNames(
  entries: Array<{ node: ProxyNode; path: string }>,
  groups: ReadonlySet<string>,
  builtins: ReadonlySet<string>,
  ctx: ExportContext,
) {
  const reserved = new Set([...groups, ...builtins, ...entries.map((e) => e.node.name)])
  const used = new Set<string>()
  const firstName = new Map<string, string>()
  const names = entries.map(({ node, path }) => {
    const original = node.name
    let name = original
    if (used.has(name) || groups.has(name) || builtins.has(name)) {
      let n = 2
      while (reserved.has(`${original} ${n}`) || used.has(`${original} ${n}`)) n++
      name = `${original} ${n}`
      ctx.warn(
        'DUPLICATE_PROXY_NAME',
        path,
        'kept',
        'renamed because the name is already used by another proxy, a group or a built-in policy',
      )
    }
    used.add(name)
    if (!firstName.has(original)) firstName.set(original, name)
    return name
  })
  return { names, firstName }
}

function groupType(
  spec: TargetSpec,
  group: ProxyGroup,
  path: string,
  ctx: ExportContext,
): ProxyGroupType {
  const supported = new Set(spec.capabilities.groupTypes)
  if (supported.has(group.type)) return group.type
  const type = GROUP_FALLBACK[group.type].find((t) => supported.has(t)) ?? 'select'
  ctx.warn(
    'UNSUPPORTED_GROUP_TYPE',
    `${path}.type`,
    'downgraded',
    `${spec.target} does not support ${group.type} groups; ${type} is used instead`,
  )
  return type
}

function resolveGroup(
  spec: TargetSpec,
  group: ProxyGroup,
  path: string,
  groupNames: ReadonlySet<string>,
  proxyName: ReadonlyMap<string, string>,
  ctx: ExportContext,
): ResolvedGroup {
  const type = groupType(spec, group, path, ctx)
  const members: string[] = []
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
        `the ${m.kind} referenced by this member does not exist or was dropped`,
      )
    } else {
      members.push(name)
    }
  })
  const extra = ctx.extra(group.extra, path)
  const autoMembers = group.includeAllProxies || spec.hasAutoMembers?.(extra)
  if (!members.length && !autoMembers) {
    members.push('DIRECT')
    ctx.warn('EMPTY_GROUP', path, 'downgraded', 'the group has no members left; DIRECT was added')
  }
  return { group, path, type, members, extra }
}

/** raw.githubusercontent.com 和 github.com/<owner>/<repo>/raw 的地址 */
const GITHUB_RAW = [
  /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(?:refs\/(?:heads|tags)\/)?([^/]+)\/(.+)$/,
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/(?:refs\/(?:heads|tags)\/)?([^/]+)\/(.+)$/,
]

/** 按镜像设置改写地址；无法改写时返回 undefined */
function mirrorUrl(url: string, mirror: RuleSetMirror): string | undefined {
  if (mirror === 'original') return url
  if (mirror !== 'jsdelivr') return `${mirror.prefix}${url}`
  for (const re of GITHUB_RAW) {
    const m = re.exec(url)
    if (m) return `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`
  }
  return undefined
}

function resolveRuleSets(
  spec: TargetSpec,
  profile: Profile,
  mirror: RuleSetMirror,
  ctx: ExportContext,
) {
  const sets = new Map<string, ResolvedRuleSet>()
  profile.ruleSets.forEach((set, i) => {
    const path = `ruleSets[${i}]`
    if (sets.has(set.id)) {
      ctx.warn(
        'DUPLICATE_RULE_SET_ID',
        path,
        'dropped',
        'a rule set with the same id already exists',
      )
      return
    }
    const source = spec.ruleSetSource(set)
    if ('code' in source) {
      ctx.warn(source.code, path, 'dropped', source.message)
      return
    }
    let url = mirrorUrl(source.url, mirror)
    if (url === undefined) {
      url = source.url
      ctx.warn(
        'RULE_SET_MIRROR_UNSUPPORTED',
        path,
        'kept',
        'the mirror cannot serve this URL; the original URL is used',
        'info',
      )
    }
    sets.set(set.id, { set, path, source: { ...source, url }, extra: ctx.extra(set.extra, path) })
  })
  return sets
}

const OPTION_PATH = 'options.ruleSetPolicy'

function ruleSetPolicy(
  spec: TargetSpec,
  groups: ResolvedGroup[],
  opts: ExportOptions,
  ctx: ExportContext,
): string | undefined {
  let policy = opts.ruleSetPolicy ?? groups.find((g) => g.type === 'select')?.group.name
  if (policy === undefined) policy = 'DIRECT'
  else if (policy !== 'DIRECT' && !groups.some((g) => g.group.name === policy)) {
    ctx.warn(
      'UNKNOWN_RULE_SET_POLICY',
      OPTION_PATH,
      'downgraded',
      'the group for downloading rule sets does not exist; DIRECT is used instead',
    )
    policy = 'DIRECT'
  }
  if (spec.capabilities.ruleSetProxy) return policy
  if (policy !== 'DIRECT') {
    const mirrored = (opts.ruleSetMirror ?? 'original') !== 'original'
    ctx.warn(
      'RULE_SET_PROXY_UNSUPPORTED',
      OPTION_PATH,
      'dropped',
      `${spec.target} cannot download rule sets through a policy group` +
        (mirrored ? '' : '; use a rule set mirror if the original URLs are not reachable directly'),
      mirrored ? 'info' : 'warn',
    )
  }
  return undefined
}

function conditions(c: RuleCondition): RuleCondition[] {
  return [c, ...(c.children ?? []).flatMap(conditions)]
}

function resolveRules(
  spec: TargetSpec,
  rules: Rule[],
  ruleSets: ReadonlyMap<string, ResolvedRuleSet>,
  groupNames: ReadonlySet<string>,
  proxyName: ReadonlyMap<string, string>,
  ctx: ExportContext,
): ResolvedRule[] {
  const caps = spec.capabilities
  const types = new Set(caps.ruleTypes)
  const out: ResolvedRule[] = []
  rules.forEach((rule, i) => {
    const path = `rules[${i}]`
    const all = conditions(rule)
    const unsupported = all.find(
      (c) => !types.has(c.type) || (LOGICAL_RULE_TYPES.has(c.type) && !caps.logicalRules),
    )
    if (unsupported) {
      ctx.warn(
        'UNSUPPORTED_RULE_TYPE',
        path,
        'dropped',
        `${spec.target} does not support ${unsupported.type} rules`,
      )
      return
    }
    for (const c of all) {
      const reason = spec.checkRule?.(c)
      if (reason !== undefined) {
        ctx.warn('UNSUPPORTED_RULE_PARAM', path, 'dropped', reason)
        return
      }
    }
    if (all.some((c) => c.type === 'RULE-SET' && !ruleSets.has(c.value ?? ''))) {
      ctx.warn(
        'UNKNOWN_RULE_SET',
        path,
        'dropped',
        'the rule references a rule set that does not exist or cannot be exported',
      )
      return
    }
    const target =
      groupNames.has(rule.target) || spec.builtins.has(rule.target)
        ? rule.target
        : proxyName.get(rule.target)
    if (target === undefined) {
      ctx.warn('UNKNOWN_RULE_TARGET', path, 'dropped', 'the rule target does not exist')
      return
    }
    out.push({ rule, path, target })
  })
  return out
}

/** nodes 是经过流水线处理的订阅节点，排在 profile.proxies 之后 */
export function resolveProfile(
  spec: TargetSpec,
  profile: Profile,
  nodes: readonly ProxyNode[],
  opts: ExportOptions,
  ctx: ExportContext,
): ResolvedProfile {
  const uniq = uniqueGroups(profile.groups, ctx)
  const groupNames = new Set(uniq.map((g) => g.group.name))

  const entries = supportedProxies(
    spec,
    [
      ...profile.proxies.map((node, i) => ({ node, path: `proxies[${i}]` })),
      ...nodes.map((node, i) => ({ node, path: `nodes[${i}]` })),
    ],
    ctx,
  )
  const { names, firstName } = assignNames(entries, groupNames, spec.builtins, ctx)
  const proxies = entries.map(({ node, path }, i) => ({
    node,
    path,
    name: names[i] ?? node.name,
    extra: ctx.extra(node.extra, path),
  }))

  const groups = uniq.map(({ group, path }) =>
    resolveGroup(spec, group, path, groupNames, firstName, ctx),
  )
  const ruleSets = resolveRuleSets(spec, profile, opts.ruleSetMirror ?? 'original', ctx)
  const policy = ruleSets.size ? ruleSetPolicy(spec, groups, opts, ctx) : undefined
  const rules = resolveRules(spec, profile.rules, ruleSets, groupNames, firstName, ctx)
  return { proxies, groups, ruleSets, rules, ruleSetPolicy: policy }
}
