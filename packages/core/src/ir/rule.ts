import { z } from 'zod'
import { NonEmptyString } from './common.js'

export const RuleTypeSchema = z.enum([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'IP-CIDR',
  'IP-CIDR6',
  'GEOIP',
  'GEOSITE',
  'IP-ASN',
  'RULE-SET',
  'PROCESS-NAME',
  'DST-PORT',
  'SRC-IP-CIDR',
  'AND',
  'OR',
  'NOT',
  'MATCH',
])
export type RuleType = z.infer<typeof RuleTypeSchema>

export const LOGICAL_RULE_TYPES: ReadonlySet<RuleType> = new Set(['AND', 'OR', 'NOT'])

/** 支持 src 参数（按来源 IP 匹配）的规则类型，与 mihomo 一致 */
export const SRC_RULE_TYPES: ReadonlySet<RuleType> = new Set([
  'IP-CIDR',
  'IP-CIDR6',
  'GEOIP',
  'IP-ASN',
  'RULE-SET',
])

interface ConditionShape {
  type: RuleType
  value?: string | undefined
  children?: ConditionShape[] | undefined
  src?: boolean | undefined
}

/**
 * 逻辑规则必须有子条件且没有 value，MATCH 没有 value，其余规则必须有 value。
 * src 只能用于 SRC_RULE_TYPES。
 */
function checkCondition(rule: ConditionShape, ctx: z.RefinementCtx) {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (rule.src && !SRC_RULE_TYPES.has(rule.type)) issue(`${rule.type} does not support src`)
  if (LOGICAL_RULE_TYPES.has(rule.type)) {
    if (rule.value !== undefined) issue(`${rule.type} must not have a value`)
    if (!rule.children?.length) issue(`${rule.type} requires children`)
    else if (rule.type === 'NOT' && rule.children.length !== 1)
      issue('NOT requires exactly one child')
    return
  }
  if (rule.children !== undefined) issue(`${rule.type} must not have children`)
  if (rule.type === 'MATCH') {
    if (rule.value !== undefined) issue('MATCH must not have a value')
  } else if (rule.value === undefined) {
    issue(`${rule.type} requires a value`)
  }
}

const conditionShape = {
  type: RuleTypeSchema,
  /** MATCH 无 value；RULE-SET 的 value 为 ruleSet id */
  value: NonEmptyString.optional(),
  /** AND / OR / NOT 的子条件（子条件没有 target） */
  get children() {
    return z.array(RuleConditionSchema).optional()
  },
  noResolve: z.boolean().optional(),
  /** 按来源 IP 匹配（mihomo 的 src 参数），仅用于 SRC_RULE_TYPES */
  src: z.boolean().optional(),
}

export const RuleConditionSchema = z.strictObject(conditionShape).superRefine(checkCondition)
export type RuleCondition = z.infer<typeof RuleConditionSchema>

export const RuleSchema = z
  .strictObject({
    ...conditionShape,
    /** 策略组名或 BuiltinTarget */
    target: NonEmptyString,
  })
  .superRefine(checkCondition)
export type Rule = z.infer<typeof RuleSchema>
