import { type RuleSet, RuleSetBehaviorSchema, RuleSetSchema } from '../../ir/index.js'
import type { ImportWarning } from '../types.js'
import { canonical, describeIssues, extraOf, ImportError, isRecord, Reader } from '../util.js'

const bad = (message: string) => new ImportError('INVALID_RULE_PROVIDER', message)
const FORMATS = ['yaml', 'text', 'mrs'] as const

function convertProvider(name: string, src: unknown): RuleSet {
  if (!isRecord(src)) throw bad('rule provider must be a mapping')
  const r = new Reader(src)
  const type = r.str('type')
  if (type === 'file' || type === 'inline') {
    throw new ImportError(
      'UNSUPPORTED_RULE_PROVIDER',
      `rule provider type "${type}" is not supported`,
    )
  }
  if (type !== 'http') throw bad('"type" must be http, file or inline')
  const behavior = RuleSetBehaviorSchema.safeParse(r.str('behavior'))
  if (!behavior.success) throw bad('"behavior" must be domain, ipcidr or classical')
  const url = r.str('url')
  if (!url) throw bad('"url" is required')
  const format = r.str('format') ?? 'yaml'
  if (!(FORMATS as readonly string[]).includes(format))
    throw bad('"format" must be yaml, text or mrs')

  const parsed = RuleSetSchema.safeParse(
    canonical({
      id: name,
      name,
      behavior: behavior.data,
      sources: { mihomo: { url, format } },
      interval: r.int('interval'),
      extra: extraOf('mihomo', r.rest()),
    }),
  )
  if (!parsed.success) throw bad(describeIssues(parsed.error))
  return parsed.data
}

export function convertRuleProviders(src: unknown, warnings: ImportWarning[]): RuleSet[] {
  if (src === undefined || src === null) return []
  if (!isRecord(src)) {
    warnings.push({
      level: 'warn',
      code: 'INVALID_RULE_PROVIDER',
      path: 'rule-providers',
      message: '"rule-providers" must be a mapping',
    })
    return []
  }
  const sets: RuleSet[] = []
  for (const [name, item] of Object.entries(src)) {
    try {
      sets.push(convertProvider(name, item))
    } catch (e) {
      if (!(e instanceof ImportError)) throw e
      const code = e.code === 'INVALID_PROXY' ? 'INVALID_RULE_PROVIDER' : e.code
      warnings.push({ level: 'warn', code, path: `rule-providers.${name}`, message: e.message })
    }
  }
  return sets
}
