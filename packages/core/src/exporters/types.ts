import { z } from 'zod'
import type {
  Profile,
  ProxyGroupType,
  ProxyNode,
  ProxyType,
  RuleSetFormatSchema,
  RuleType,
  Target,
} from '../ir/index.js'

/** 规则集镜像：原始地址、jsDelivr，或在原始地址前加自定义前缀 */
export const RuleSetMirrorSchema = z.union([
  z.enum(['original', 'jsdelivr']),
  z.strictObject({ prefix: z.url({ protocol: /^https?$/ }) }),
])
export type RuleSetMirror = z.infer<typeof RuleSetMirrorSchema>

export const ExportOptionsSchema = z.strictObject({
  /** 节点未设置 udp 时是否开启 UDP，默认 true */
  defaultUdp: z.boolean().optional(),
  /**
   * 通过哪个策略组下载规则集：策略组名或 DIRECT。
   * 默认为 profile 中第一个 select 组，没有时为 DIRECT。
   */
  ruleSetPolicy: z.string().min(1).optional(),
  /** 规则集地址改写，默认 original */
  ruleSetMirror: RuleSetMirrorSchema.optional(),
  /**
   * 仅 mihomo：订阅节点改由 proxy-providers 引用（server 生成，指向托管的节点列表）。
   * 设置后 nodes 不写入配置，includeAllProxies 的组加上 use。
   */
  proxyProvider: z
    .strictObject({
      name: z.string().min(1),
      url: z.url({ protocol: /^https?$/ }),
      /** 更新间隔（秒） */
      interval: z.number().int().positive().optional(),
    })
    .optional(),
})
export type ExportOptions = z.infer<typeof ExportOptionsSchema>

export type CompatWarningCode =
  | 'UNSUPPORTED_PROXY_TYPE'
  | 'UNSUPPORTED_PROXY_FEATURE'
  | 'UNSUPPORTED_GROUP_TYPE'
  | 'UNSUPPORTED_RULE_TYPE'
  | 'UNSUPPORTED_RULE_PARAM'
  | 'UNSUPPORTED_RULE_VALUE'
  | 'INVALID_NAME_CHARS'
  | 'DUPLICATE_PROXY_NAME'
  | 'DUPLICATE_GROUP_NAME'
  | 'UNKNOWN_GROUP_MEMBER'
  | 'EMPTY_GROUP'
  | 'UNKNOWN_RULE_TARGET'
  | 'UNKNOWN_RULE_SET'
  | 'DUPLICATE_RULE_SET_ID'
  | 'RULE_SET_NO_SOURCE'
  | 'UNSUPPORTED_RULE_SET_FORMAT'
  | 'UNKNOWN_RULE_SET_POLICY'
  | 'RULE_SET_PROXY_UNSUPPORTED'
  | 'RULE_SET_MIRROR_UNSUPPORTED'
  | 'UNSUPPORTED_GROUP_OPTION'
  | 'GROUP_FILTER_REWRITTEN'
  | 'TEST_URL_REWRITTEN'
  | 'UNREACHABLE_RULE'
  | 'MISSING_FINAL_RULE'
  | 'UNSUPPORTED_SETTING'
  | 'UNSUPPORTED_DNS_SERVER'
  | 'EXTRA_IGNORED'

/** 导出时的兼容性警告。前端用 code 做多语言，message 是英文说明。 */
export interface CompatWarning {
  level: 'info' | 'warn' | 'error'
  /**
   * 如 groups[2]、nodes[5]（订阅节点）、proxies[0]（手动节点）、rules[3]；
   * 与导出选项有关的为 options.<选项名>
   */
  path: string
  code: CompatWarningCode
  message: string
  action: 'dropped' | 'downgraded' | 'kept'
}

export interface Capabilities {
  proxyTypes: ProxyType[]
  groupTypes: ProxyGroupType[]
  ruleTypes: RuleType[]
  logicalRules: boolean
  ruleSetFormats: z.infer<typeof RuleSetFormatSchema>[]
  /** 能否指定通过某个策略组下载规则集 */
  ruleSetProxy: boolean
}

export interface ExportResult {
  text: string
  warnings: CompatWarning[]
}

export interface Exporter {
  target: Target
  capabilities: Capabilities
  /** nodes 是经过流水线处理的订阅节点，输出在 profile.proxies 之后 */
  export(profile: Profile, nodes: readonly ProxyNode[], opts?: ExportOptions): ExportResult
}
