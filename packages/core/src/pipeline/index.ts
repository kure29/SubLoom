import type { ProxyNode } from '../ir/index.js'
import { detectRegion, flagOf, regionRank, startsWithFlag } from './regions.js'
import type { PipelineOp } from './schema.js'

export { detectRegion, flagOf, REGIONS } from './regions.js'
export * from './schema.js'

export interface PipelineWarning {
  level: 'info' | 'warn' | 'error'
  code: 'INVALID_REGEX' | 'EMPTY_NAME'
  /** 如 pipeline[2] */
  path: string
  message: string
}

export interface PipelineResult {
  nodes: ProxyNode[]
  warnings: PipelineWarning[]
}

class InvalidRegex extends Error {}

/** JavaScript RegExp；为兼容 mihomo filter 的写法，允许以 (?i) 开头表示忽略大小写 */
function compile(pattern: string, global = false): RegExp {
  const insensitive = pattern.startsWith('(?i)')
  const source = insensitive ? pattern.slice(4) : pattern
  try {
    return new RegExp(source, `u${insensitive ? 'i' : ''}${global ? 'g' : ''}`)
  } catch {
    throw new InvalidRegex()
  }
}

const collator = new Intl.Collator('en', { numeric: true })

function sortNodes(nodes: ProxyNode[], op: Extract<PipelineOp, { op: 'sort' }>): ProxyNode[] {
  const dir = op.order === 'asc' ? 1 : -1
  if (op.by === 'name') {
    return nodes.toSorted((a, b) => dir * collator.compare(a.name, b.name))
  }
  // 识别不出地区的节点无论升降序都排在最后
  const keyed = nodes.map((node) => {
    const code = detectRegion(node.name)
    return { node, rank: code === undefined ? undefined : regionRank(code) }
  })
  return keyed
    .toSorted((a, b) => {
      if (!a.rank || !b.rank) return (a.rank ? 0 : 1) - (b.rank ? 0 : 1)
      const diff = a.rank[0] - b.rank[0] || a.rank[1].localeCompare(b.rank[1])
      return dir * diff
    })
    .map((k) => k.node)
}

function dedupe(nodes: ProxyNode[], by: 'name' | 'server'): ProxyNode[] {
  const seen = new Set<string>()
  return nodes.filter((n) => {
    const key = by === 'name' ? n.name : JSON.stringify([n.type, n.server, n.port])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const rename = (node: ProxyNode, name: string): ProxyNode => ({ ...node, name })

function apply(
  nodes: ProxyNode[],
  op: PipelineOp,
  warn: (code: PipelineWarning['code'], message: string) => void,
): ProxyNode[] {
  switch (op.op) {
    case 'filter-regex': {
      const re = compile(op.pattern)
      return nodes.filter((n) => re.test(n.name) === (op.mode === 'keep'))
    }
    case 'filter-type': {
      const types = new Set<string>(op.types)
      return nodes.filter((n) => types.has(n.type) === (op.mode === 'keep'))
    }
    case 'filter-region': {
      const regions = new Set(op.regions)
      return nodes.filter((n) => {
        const code = detectRegion(n.name)
        const hit = code !== undefined && regions.has(code)
        return hit === (op.mode === 'keep')
      })
    }
    case 'rename-regex': {
      const re = compile(op.pattern, true)
      let empty = 0
      const out = nodes.map((n) => {
        const name = n.name.replace(re, op.replace)
        if (name.trim()) return rename(n, name)
        empty++
        return n
      })
      if (empty) warn('EMPTY_NAME', `${empty} node(s) would get an empty name and were not renamed`)
      return out
    }
    case 'add-flag':
      return nodes.map((n) => {
        if (startsWithFlag(n.name)) return n
        const code = detectRegion(n.name)
        return code === undefined ? n : rename(n, `${flagOf(code)} ${n.name}`)
      })
    case 'sort':
      return sortNodes(nodes, op)
    case 'dedupe':
      return dedupe(nodes, op.by)
    case 'prefix':
      return nodes.map((n) => rename(n, `${op.text}${n.name}`))
    case 'suffix':
      return nodes.map((n) => rename(n, `${n.name}${op.text}`))
  }
}

/**
 * 按顺序执行流水线，返回新数组，不修改输入。
 * 某个操作出错（如正则非法）时跳过该操作并警告，不中断流水线。
 */
export function runPipeline(
  nodes: readonly ProxyNode[],
  ops: readonly PipelineOp[],
): PipelineResult {
  let current = [...nodes]
  const warnings: PipelineWarning[] = []
  ops.forEach((op, i) => {
    const path = `pipeline[${i}]`
    const warn = (code: PipelineWarning['code'], message: string) =>
      warnings.push({ level: 'warn', code, path, message })
    try {
      current = apply(current, op, warn)
    } catch (e) {
      if (!(e instanceof InvalidRegex)) throw e
      warn('INVALID_REGEX', `invalid regular expression in ${op.op}; the operation was skipped`)
    }
  })
  return { nodes: current, warnings }
}
