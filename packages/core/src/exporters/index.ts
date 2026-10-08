import type { Target } from '../ir/index.js'
import { mihomoExporter } from './mihomo/index.js'
import type { Exporter } from './types.js'

export { exportMihomo, MIHOMO_CAPABILITIES, mihomoExporter } from './mihomo/index.js'
export * from './types.js'

/** 已实现的导出器 */
export const exporters: Partial<Record<Target, Exporter>> = { mihomo: mihomoExporter }
