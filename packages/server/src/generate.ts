import {
  type CompatWarning,
  type ExportOptions,
  exporters,
  exportMihomo,
  type PipelineOp,
  type PipelineWarning,
  type Profile,
  type ProxyNode,
  runPipeline,
} from '@subloom/core'
import { type Ctx, getCachedNodes } from './sources/service.js'
import type { ExportTarget } from './sub/user-agent.js'

// 生成配置：按 sourceIds 的顺序读取节点缓存并拼接 → 流水线 → 导出。preview 与 /sub 共用。

export interface GenerateInput {
  ir: Profile
  pipeline: PipelineOp[]
  sourceIds: string[]
}

export interface GenerateResult {
  text: string
  warnings: CompatWarning[]
  pipelineWarnings: PipelineWarning[]
  /** 各订阅源的节点数；还没有节点缓存的为 null（生成时跳过） */
  sources: Array<{ id: string; nodeCount: number | null }>
}

/** 订阅节点（经过流水线）的 mihomo proxies 列表，供 proxy-providers 引用 */
export type GenerateTarget = ExportTarget | 'proxies'

/** 读取各订阅源的节点缓存，按顺序拼接 */
export async function collectNodes(ctx: Ctx, sourceIds: readonly string[]) {
  const nodes: ProxyNode[] = []
  const sources: GenerateResult['sources'] = []
  for (const id of sourceIds) {
    const cached = await getCachedNodes(ctx, id)
    sources.push({ id, nodeCount: cached ? cached.proxies.length : null })
    if (cached) nodes.push(...cached.proxies)
  }
  return { nodes, sources }
}

const EMPTY_PROFILE: Profile = {
  version: 1,
  name: 'proxies',
  proxies: [],
  groups: [],
  rules: [],
  ruleSets: [],
}

export async function generate(
  ctx: Ctx,
  input: GenerateInput,
  target: GenerateTarget,
  opts: ExportOptions = {},
): Promise<GenerateResult> {
  // 订阅节点由 proxy-provider 提供时，配置中不含订阅节点，不必读取
  const skipNodes = target === 'mihomo' && opts.proxyProvider !== undefined
  const collected = skipNodes
    ? { nodes: [], sources: input.sourceIds.map((id) => ({ id, nodeCount: null })) }
    : await collectNodes(ctx, input.sourceIds)
  const piped = runPipeline(collected.nodes, input.pipeline)
  const result =
    target === 'proxies'
      ? // 节点列表：与导出 mihomo 配置相同的名称处理（替换逗号、重名改名）
        exportMihomo(EMPTY_PROFILE, piped.nodes, { defaultUdp: opts.defaultUdp })
      : exporterFor(target).export(input.ir, piped.nodes, opts)
  return {
    text: result.text,
    warnings: result.warnings,
    pipelineWarnings: piped.warnings,
    sources: collected.sources,
  }
}

function exporterFor(target: ExportTarget) {
  const exporter = exporters[target]
  if (!exporter) throw new Error(`exporter not found: ${target}`)
  return exporter
}
