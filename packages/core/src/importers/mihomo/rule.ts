import {
  LOGICAL_RULE_TYPES,
  type Rule,
  type RuleCondition,
  RuleSchema,
  RuleTypeSchema,
} from '../../ir/index.js'
import type { ImportWarning } from '../types.js'
import { canonical, describeIssues, ImportError } from '../util.js'

const bad = (message: string) => new ImportError('INVALID_RULE', message)

/** 在 s[start] 为 '(' 时返回与之匹配的 ')' 位置 */
function matchParen(s: string, start: number): number {
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i
  }
  throw bad('unbalanced parentheses')
}

/** "(A,x),(B,y)" → ["A,x", "B,y"] */
function splitChildren(payload: string): string[] {
  const children: string[] = []
  let i = 0
  while (i < payload.length) {
    if (payload[i] !== '(') throw bad('malformed logical rule')
    const end = matchParen(payload, i)
    children.push(payload.slice(i + 1, end))
    i = end + 1
    if (i < payload.length) {
      if (payload[i] !== ',') throw bad('malformed logical rule')
      i++
    }
  }
  return children
}

interface Parsed {
  condition: RuleCondition
  /** 条件之后剩余的逗号分隔字段（target、参数） */
  tail: string[]
  /** 不支持的参数 */
  ignoredParams: string[]
}

function parseType(raw: string) {
  const type = RuleTypeSchema.safeParse(raw.trim().toUpperCase())
  if (!type.success)
    throw new ImportError('UNSUPPORTED_RULE_TYPE', `rule type "${raw.trim()}" is not supported`)
  return type.data
}

/** 解析 TYPE,value[,...] 或 AND,((...),(...))[,...] */
function parseCondition(text: string, hasTarget: boolean): Parsed {
  const s = text.trim()
  const comma = s.indexOf(',')
  const type = parseType(comma < 0 ? s : s.slice(0, comma))
  const after = comma < 0 ? '' : s.slice(comma + 1).trim()

  let condition: RuleCondition
  let fields: string[]
  if (LOGICAL_RULE_TYPES.has(type)) {
    if (!after.startsWith('(')) throw bad('logical rule requires sub-rules')
    const end = matchParen(after, 0)
    const children = splitChildren(after.slice(1, end).trim()).map((c) => {
      const child = parseCondition(c, false)
      if (child.tail.length) throw bad('malformed sub-rule')
      return child.condition
    })
    condition = { type, children }
    const tail = after.slice(end + 1).trim()
    if (tail && !tail.startsWith(',')) throw bad('malformed logical rule')
    fields = tail
      ? tail
          .slice(1)
          .split(',')
          .map((x) => x.trim())
      : []
  } else {
    fields = after ? after.split(',').map((x) => x.trim()) : []
    if (type === 'MATCH') condition = { type }
    else {
      const value = fields.shift()
      if (!value) throw bad(`${type} requires a value`)
      condition = { type, value }
    }
  }

  // 子规则没有 target，剩下的都是参数；顶层规则第一个字段是 target
  const tail = hasTarget ? fields.splice(0, 1) : []
  const ignoredParams: string[] = []
  for (const param of fields) {
    if (param.toLowerCase() === 'no-resolve') condition.noResolve = true
    else if (param) ignoredParams.push(param)
  }
  return { condition, tail, ignoredParams }
}

export function convertRules(src: unknown, warnings: ImportWarning[]): Rule[] {
  if (src === undefined || src === null) return []
  if (!Array.isArray(src)) {
    warnings.push({
      level: 'warn',
      code: 'INVALID_RULE',
      path: 'rules',
      message: '"rules" must be a list',
    })
    return []
  }
  const rules: Rule[] = []
  src.forEach((line, i) => {
    const path = `rules[${i}]`
    try {
      if (typeof line !== 'string') throw bad('rule must be a string')
      const { condition, tail, ignoredParams } = parseCondition(line, true)
      const target = tail[0]
      if (!target) throw bad('missing target')
      const parsed = RuleSchema.safeParse(canonical({ ...condition, target }))
      if (!parsed.success) throw bad(describeIssues(parsed.error))
      rules.push(parsed.data)
      if (ignoredParams.length) {
        warnings.push({
          level: 'info',
          code: 'UNSUPPORTED_RULE_PARAM',
          path,
          message: `ignored unsupported parameters: ${ignoredParams.join(', ')}`,
        })
      }
    } catch (e) {
      if (!(e instanceof ImportError)) throw e
      warnings.push({ level: 'warn', code: e.code, path, message: e.message })
    }
  })
  return rules
}
