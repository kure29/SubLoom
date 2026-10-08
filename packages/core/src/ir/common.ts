import { z } from 'zod'

export const TargetSchema = z.enum(['mihomo', 'surge', 'shadowrocket', 'loon'])
export type Target = z.infer<typeof TargetSchema>

/**
 * 无法映射的字段，按来源格式分命名空间原样保留（键名和嵌套结构不变）。
 * 导出器只合并与自己格式相同的那份。
 */
export const ExtraSchema = z.strictObject({
  mihomo: z.record(z.string(), z.unknown()).optional(),
  uri: z.record(z.string(), z.unknown()).optional(),
  surge: z.record(z.string(), z.unknown()).optional(),
})
export type Extra = z.infer<typeof ExtraSchema>
export type ExtraSource = keyof Extra

export const PortSchema = z.number().int().min(1).max(65535)
export const NonEmptyString = z.string().min(1)
