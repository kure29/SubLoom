import { describe, expect, it } from 'vitest'
import { exporters, importSubscription } from '../../src/index.js'
import { NODE_COUNT, runChain, SUBSCRIPTION } from './chain.js'

/**
 * 宽松的耗时上限，只拦截数量级的性能回退（CI runner 性能波动较大）。
 * 开发机上完整链路约 15–20ms（PLAN.md 5.6），换回通用 YAML 库时约 120ms。
 * 精确耗时见 `pnpm --filter @subloom/core bench`，CI 中写入 job summary。
 */
const BUDGET_MS = 100

const imported = importSubscription(SUBSCRIPTION).proxies

describe(`performance: ${NODE_COUNT} nodes`, () => {
  it('imports every node', () => {
    expect(imported).toHaveLength(NODE_COUNT)
  })

  it.each(Object.values(exporters))('full chain to $target stays within budget', (exporter) => {
    runChain(exporter)
    // 预热后取多次运行中最快的一次，减少偶发抖动
    const times = Array.from({ length: 5 }, () => {
      const start = performance.now()
      runChain(exporter)
      return performance.now() - start
    })
    expect(Math.min(...times)).toBeLessThan(BUDGET_MS)
  })

  it.each(Object.values(exporters))('$target keeps every supported node', (exporter) => {
    const { text, warnings } = runChain(exporter)
    const supported = imported.filter((p) => exporter.capabilities.proxyTypes.includes(p.type))
    expect(text.match(/\[A\] /g)).toHaveLength(supported.length)
    // 只有不支持的节点类型和规则集下载策略的警告
    const unsupported = NODE_COUNT - supported.length
    expect(warnings.filter((w) => w.code === 'UNSUPPORTED_PROXY_TYPE')).toHaveLength(unsupported)
    expect(
      warnings.filter(
        (w) => w.code !== 'UNSUPPORTED_PROXY_TYPE' && w.code !== 'RULE_SET_PROXY_UNSUPPORTED',
      ),
    ).toEqual([])
  })
})
