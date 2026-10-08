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

export const ExportOptionsSchema = z.strictObject({
  /** 节点未设置 udp 时是否开启 UDP，默认 true */
  defaultUdp: z.boolean().optional(),
})
export type ExportOptions = z.infer<typeof ExportOptionsSchema>

export type CompatWarningCode =
  | 'DUPLICATE_PROXY_NAME'
  | 'DUPLICATE_GROUP_NAME'
  | 'UNKNOWN_GROUP_MEMBER'
  | 'EMPTY_GROUP'
  | 'UNKNOWN_RULE_TARGET'
  | 'UNKNOWN_RULE_SET'
  | 'RULE_SET_NO_SOURCE'
  | 'UNSUPPORTED_RULE_SET_FORMAT'
  | 'EXTRA_IGNORED'

/** 导出时的兼容性警告。前端用 code 做多语言，message 是英文说明。 */
export interface CompatWarning {
  level: 'info' | 'warn' | 'error'
  /** 如 groups[2]、nodes[5]（订阅节点）、proxies[0]（手动节点）、rules[3] */
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
