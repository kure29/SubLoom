import { z } from 'zod'
import { ExtraSchema, NonEmptyString, PortSchema } from './common.js'
import { ProxyGroupSchema } from './group.js'
import { ProxySchema } from './proxy.js'
import { RuleSchema } from './rule.js'
import { RuleSetSchema } from './ruleset.js'

export const GeneralConfigSchema = z.strictObject({
  port: PortSchema.optional(),
  socksPort: PortSchema.optional(),
  redirPort: PortSchema.optional(),
  tproxyPort: PortSchema.optional(),
  mixedPort: PortSchema.optional(),
  allowLan: z.boolean().optional(),
  bindAddress: NonEmptyString.optional(),
  mode: z.enum(['rule', 'global', 'direct']).optional(),
  logLevel: z.enum(['silent', 'error', 'warning', 'info', 'debug']).optional(),
  ipv6: z.boolean().optional(),
  extra: ExtraSchema.optional(),
})
export type GeneralConfig = z.infer<typeof GeneralConfigSchema>

export const DnsConfigSchema = z.strictObject({
  enable: z.boolean().optional(),
  ipv6: z.boolean().optional(),
  listen: NonEmptyString.optional(),
  enhancedMode: z.enum(['fake-ip', 'redir-host', 'normal']).optional(),
  fakeIpRange: NonEmptyString.optional(),
  defaultNameserver: z.array(NonEmptyString).optional(),
  nameserver: z.array(NonEmptyString).optional(),
  fallback: z.array(NonEmptyString).optional(),
  extra: ExtraSchema.optional(),
})
export type DnsConfig = z.infer<typeof DnsConfigSchema>

export const ProfileSchema = z.strictObject({
  version: z.literal(1),
  name: NonEmptyString,
  general: GeneralConfigSchema.optional(),
  dns: DnsConfigSchema.optional(),
  /** 手动添加的节点 */
  proxies: z.array(ProxySchema),
  groups: z.array(ProxyGroupSchema),
  /** 有序 */
  rules: z.array(RuleSchema),
  ruleSets: z.array(RuleSetSchema),
  extra: ExtraSchema.optional(),
})
export type Profile = z.infer<typeof ProfileSchema>
