import type { Extra, ExtraSource } from '../ir/index.js'
import type { CompatWarning } from './types.js'

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 去掉值为 undefined 的键；结果为空对象时返回 undefined */
export function compact(o: Record<string, unknown>): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined
  for (const k of Object.keys(o)) {
    if (o[k] === undefined) continue
    out ??= {}
    out[k] = o[k]
  }
  return out
}

/** 深度合并 extra：已有的键（来自 IR）优先，同为对象时递归合并 */
export function mergeExtra(
  base: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!extra) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k]
    if (cur === undefined) out[k] = v
    else if (isRecord(cur) && isRecord(v)) out[k] = mergeExtra(cur, v)
  }
  return out
}

/** 取出目标格式的 extra，其余命名空间给出 EXTRA_IGNORED 警告 */
export function extraFor(
  target: ExtraSource,
  extra: Extra | undefined,
  path: string,
  warnings: CompatWarning[],
): Record<string, unknown> | undefined {
  if (!extra) return undefined
  for (const ns of Object.keys(extra) as ExtraSource[]) {
    if (ns === target || !extra[ns]) continue
    warnings.push({
      level: 'warn',
      path: `${path ? `${path}.` : ''}extra.${ns}`,
      code: 'EXTRA_IGNORED',
      message: `fields from the ${ns} format cannot be exported to ${target}`,
      action: 'dropped',
    })
  }
  return extra[target]
}
