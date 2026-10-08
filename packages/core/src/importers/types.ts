import type {
  DnsConfig,
  Extra,
  GeneralConfig,
  ProxyGroup,
  ProxyNode,
  Rule,
  RuleSet,
} from '../ir/index.js'

export type ImportFormat = 'mihomo-yaml' | 'uri-list' | 'base64-uri-list' | 'unknown'

export type ImportWarningCode =
  | 'EMPTY_INPUT'
  | 'UNKNOWN_FORMAT'
  | 'INVALID_YAML'
  | 'INVALID_URI'
  | 'INVALID_PROXY'
  | 'UNSUPPORTED_PROTOCOL'
  | 'UNSUPPORTED_TRANSPORT'
  | 'INVALID_GROUP'
  | 'UNSUPPORTED_GROUP_TYPE'
  | 'UNKNOWN_GROUP_MEMBER'
  | 'INVALID_RULE'
  | 'UNSUPPORTED_RULE_TYPE'
  | 'UNSUPPORTED_RULE_PARAM'
  | 'INVALID_RULE_PROVIDER'
  | 'UNSUPPORTED_RULE_PROVIDER'

/** 导入警告。message 不包含原始内容（链接、密码、服务器地址），前端用 code 做多语言。 */
export interface ImportWarning {
  level: 'info' | 'warn' | 'error'
  code: ImportWarningCode
  /** 协议名，如 vmess、tuic */
  protocol?: string
  /** URI 列表中的行号（从 1 开始） */
  line?: number
  /** YAML 中的位置，如 proxies[3]、rules[12] */
  path?: string
  message: string
}

/** mihomo YAML 中除节点以外的内容 */
export interface ImportedConfig {
  general?: GeneralConfig
  dns?: DnsConfig
  groups: ProxyGroup[]
  ruleSets: RuleSet[]
  rules: Rule[]
  extra?: Extra
}

export interface ImportResult {
  format: ImportFormat
  proxies: ProxyNode[]
  config?: ImportedConfig
  warnings: ImportWarning[]
}
