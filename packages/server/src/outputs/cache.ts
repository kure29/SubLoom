import { sha256Hex } from '../crypto.js'

// 生成结果缓存的键。见 PLAN.md 5.3"生成结果缓存"。

export interface CacheKeyInput {
  /** @subloom/core 的版本（CORE_VERSION） */
  coreVersion: string
  /** 缓存的内容：某个导出器的配置，或节点列表（proxies） */
  target: string
  profile: { irJson: string; pipelineJson: string; sourceIdsJson: string }
  optionsJson: string
  /** nodes: 'provider' 时配置中的 provider 地址（含 token） */
  providerUrl: string | null
  /** 各订阅源的节点缓存版本（id, nodes_fetched_at）；内容不含订阅节点时为 null */
  nodes: ReadonlyArray<readonly [string, number | null]> | null
}

export interface CacheKeys {
  /** profile、导出选项、target、core 版本、provider 地址：变化时同步重新生成 */
  configKey: string
  /** 节点缓存版本：只有它变化时先返回旧结果，后台重新生成 */
  nodesKey: string
}

/** 各项以 JSON 数组拼接后取 SHA-256，没有拼接歧义 */
export async function cacheKeys(input: CacheKeyInput): Promise<CacheKeys> {
  const { coreVersion, target, profile, optionsJson, providerUrl, nodes } = input
  const configKey = await sha256Hex(
    JSON.stringify([
      coreVersion,
      target,
      profile.irJson,
      profile.pipelineJson,
      profile.sourceIdsJson,
      optionsJson,
      providerUrl,
    ]),
  )
  const nodesKey = nodes === null ? '' : await sha256Hex(JSON.stringify(nodes))
  return { configKey, nodesKey }
}
