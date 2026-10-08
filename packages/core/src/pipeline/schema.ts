import { z } from 'zod'
import { ProxyTypeSchema } from '../ir/index.js'

const Mode = z.enum(['keep', 'drop'])
/** ISO 3166-1 alpha-2 */
const RegionCode = z.string().regex(/^[A-Z]{2}$/)

/** 流水线操作：纯数据，不含代码 */
export const PipelineOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('filter-regex'), pattern: z.string().min(1), mode: Mode }),
  z.strictObject({ op: z.literal('filter-type'), types: z.array(ProxyTypeSchema), mode: Mode }),
  z.strictObject({ op: z.literal('filter-region'), regions: z.array(RegionCode), mode: Mode }),
  z.strictObject({
    op: z.literal('rename-regex'),
    pattern: z.string().min(1),
    replace: z.string(),
  }),
  z.strictObject({ op: z.literal('add-flag') }),
  z.strictObject({
    op: z.literal('sort'),
    by: z.enum(['name', 'region']),
    order: z.enum(['asc', 'desc']),
  }),
  z.strictObject({ op: z.literal('dedupe'), by: z.enum(['name', 'server']) }),
  z.strictObject({ op: z.literal('prefix'), text: z.string().min(1) }),
  z.strictObject({ op: z.literal('suffix'), text: z.string().min(1) }),
  /** 强制开启 UDP；pattern 和 types 都不给时作用于全部节点，都给时两者都要满足 */
  z.strictObject({
    op: z.literal('force-udp'),
    pattern: z.string().min(1).optional(),
    types: z.array(ProxyTypeSchema).min(1).optional(),
  }),
])
export type PipelineOp = z.infer<typeof PipelineOpSchema>

export const PipelineSchema = z.array(PipelineOpSchema)
