import { z } from 'zod'
import { ExtraSchema, NonEmptyString } from './common.js'

export const BuiltinTargetSchema = z.enum(['DIRECT', 'REJECT', 'REJECT-DROP'])
export type BuiltinTarget = z.infer<typeof BuiltinTargetSchema>

export const GroupMemberSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('proxy'), name: NonEmptyString }),
  z.strictObject({ kind: z.literal('group'), name: NonEmptyString }),
  z.strictObject({ kind: z.literal('builtin'), name: BuiltinTargetSchema }),
])
export type GroupMember = z.infer<typeof GroupMemberSchema>

export const ProxyGroupTypeSchema = z.enum(['select', 'url-test', 'fallback', 'load-balance'])
export type ProxyGroupType = z.infer<typeof ProxyGroupTypeSchema>

export const ProxyGroupSchema = z.strictObject({
  name: NonEmptyString,
  type: ProxyGroupTypeSchema,
  members: z.array(GroupMemberSchema),
  /** 包含订阅中的全部节点 */
  includeAllProxies: z.boolean().optional(),
  /** 正则 */
  filter: z
    .strictObject({ include: NonEmptyString.optional(), exclude: NonEmptyString.optional() })
    .optional(),
  testUrl: NonEmptyString.optional(),
  interval: z.number().int().positive().optional(),
  tolerance: z.number().int().nonnegative().optional(),
  hidden: z.boolean().optional(),
  icon: NonEmptyString.optional(),
  extra: ExtraSchema.optional(),
})
export type ProxyGroup = z.infer<typeof ProxyGroupSchema>
