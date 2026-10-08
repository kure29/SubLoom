import { exporters } from '@subloom/core'

// target=auto 时按 User-Agent 识别客户端。见 PLAN.md 5.3"User-Agent 识别"。

export type ClientId = 'surge' | 'shadowrocket' | 'loon' | 'stash' | 'mihomo' | 'unknown'

/** 已实现导出器的客户端 */
export type ExportTarget = 'mihomo' | 'surge'

export interface DetectedClient {
  client: ClientId
  /** 实际导出的客户端 */
  target: ExportTarget
  /** 识别出了客户端，但它的导出器还没实现，回退到 mihomo */
  fallback: boolean
}

/** 按顺序匹配：Shadowrocket、Loon 在前，它们的 UA 可能带有其他客户端的关键字 */
const PATTERNS: ReadonlyArray<readonly [RegExp, Exclude<ClientId, 'unknown'>]> = [
  [/shadowrocket/i, 'shadowrocket'],
  [/\bloon\b/i, 'loon'],
  [/\bsurge\b/i, 'surge'],
  [/\bstash\b/i, 'stash'],
  [/mihomo|clash|nyanpasu/i, 'mihomo'],
]

/** 各客户端使用的导出器；Stash 读取 mihomo（Clash）格式 */
const TARGETS: Record<Exclude<ClientId, 'unknown'>, string> = {
  surge: 'surge',
  shadowrocket: 'shadowrocket',
  loon: 'loon',
  stash: 'mihomo',
  mihomo: 'mihomo',
}

const isExportTarget = (t: string): t is ExportTarget => Object.hasOwn(exporters, t)

export function detectClient(userAgent: string | undefined): DetectedClient {
  const client = PATTERNS.find(([re]) => re.test(userAgent ?? ''))?.[1]
  if (!client) return { client: 'unknown', target: 'mihomo', fallback: false }
  const target = TARGETS[client]
  return isExportTarget(target)
    ? { client, target, fallback: false }
    : { client, target: 'mihomo', fallback: true }
}
