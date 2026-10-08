import { describe, expect, it } from 'vitest'
import { exporters } from '../../src/index.js'
import { NODE_COUNT, runChain } from './chain.js'

/**
 * 宽松的耗时上限，只拦截数量级的性能回退（CI runner 性能波动较大）。
 * 精确耗时见 `pnpm --filter @subloom/core bench`，CI 中写入 job summary。
 */
const BUDGET_MS = 500

describe(`performance: ${NODE_COUNT} nodes`, () => {
  it.each(Object.values(exporters))('full chain to $target stays within budget', (exporter) => {
    const first = runChain(exporter)
    expect(first.warnings).toEqual([])
    // 预热后取多次运行中最快的一次，减少偶发抖动
    const times = Array.from({ length: 5 }, () => {
      const start = performance.now()
      runChain(exporter)
      return performance.now() - start
    })
    expect(Math.min(...times)).toBeLessThan(BUDGET_MS)
  })

  it('keeps every node', () => {
    for (const exporter of Object.values(exporters)) {
      const { text } = runChain(exporter)
      expect(text.match(/\[A\] /g)?.length).toBeGreaterThanOrEqual(NODE_COUNT)
    }
  })
})
