import { z } from 'zod'
import { ExtraSchema, NonEmptyString } from './common.js'

export const RuleSetBehaviorSchema = z.enum(['domain', 'ipcidr', 'classical'])
export const RuleSetFormatSchema = z.enum(['yaml', 'text', 'mrs', 'list'])

export const RuleSetSourceSchema = z.strictObject({
  url: NonEmptyString,
  format: RuleSetFormatSchema,
})

export const RuleSetSchema = z.strictObject({
  id: NonEmptyString,
  name: NonEmptyString,
  behavior: RuleSetBehaviorSchema,
  /** 各客户端对应的远程地址与格式 */
  sources: z.strictObject({
    mihomo: RuleSetSourceSchema.optional(),
    surge: RuleSetSourceSchema.optional(),
    shadowrocket: RuleSetSourceSchema.optional(),
    loon: RuleSetSourceSchema.optional(),
  }),
  interval: z.number().int().positive().optional(),
  extra: ExtraSchema.optional(),
})
export type RuleSet = z.infer<typeof RuleSetSchema>
