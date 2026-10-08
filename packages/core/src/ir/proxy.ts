import { z } from 'zod'
import { ExtraSchema, NonEmptyString, PortSchema } from './common.js'

export const ProxyTypeSchema = z.enum([
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria2',
  'tuic',
  'wireguard',
  'anytls',
  'http',
  'socks5',
])
export type ProxyType = z.infer<typeof ProxyTypeSchema>

/** 存在即启用 TLS */
export const TlsOptionsSchema = z.strictObject({
  sni: NonEmptyString.optional(),
  alpn: z.array(NonEmptyString).min(1).optional(),
  skipCertVerify: z.boolean().optional(),
  /** uTLS 指纹，如 chrome */
  clientFingerprint: NonEmptyString.optional(),
  /** 证书指纹（pin） */
  certFingerprint: NonEmptyString.optional(),
  reality: z
    .strictObject({
      publicKey: NonEmptyString,
      shortId: z.string().optional(),
    })
    .optional(),
  ech: z.strictObject({ config: NonEmptyString.optional() }).optional(),
})
export type TlsOptions = z.infer<typeof TlsOptionsSchema>

const StringRecord = z.record(z.string(), z.string())

export const TransportSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ws'),
    path: NonEmptyString.optional(),
    host: NonEmptyString.optional(),
    /** 除 Host 以外的请求头 */
    headers: StringRecord.optional(),
    maxEarlyData: z.number().int().nonnegative().optional(),
    earlyDataHeaderName: NonEmptyString.optional(),
  }),
  z.strictObject({
    type: z.literal('httpupgrade'),
    path: NonEmptyString.optional(),
    host: NonEmptyString.optional(),
    headers: StringRecord.optional(),
  }),
  z.strictObject({
    type: z.literal('grpc'),
    serviceName: NonEmptyString.optional(),
  }),
  z.strictObject({
    type: z.literal('h2'),
    path: NonEmptyString.optional(),
    host: z.array(NonEmptyString).min(1).optional(),
  }),
  /** TCP + HTTP 伪装 */
  z.strictObject({
    type: z.literal('http'),
    method: NonEmptyString.optional(),
    path: z.array(NonEmptyString).min(1).optional(),
    host: z.array(NonEmptyString).min(1).optional(),
    /** 除 Host 以外的请求头 */
    headers: z.record(z.string(), z.array(z.string())).optional(),
  }),
])
export type Transport = z.infer<typeof TransportSchema>
export type TransportType = Transport['type']

export const SsPluginSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('obfs'),
    mode: z.enum(['http', 'tls']),
    host: NonEmptyString.optional(),
  }),
  z.strictObject({
    type: z.literal('v2ray-plugin'),
    mode: z.literal('websocket'),
    host: NonEmptyString.optional(),
    path: NonEmptyString.optional(),
    tls: z.boolean().optional(),
    mux: z.boolean().optional(),
    skipCertVerify: z.boolean().optional(),
    headers: StringRecord.optional(),
  }),
])
export type SsPlugin = z.infer<typeof SsPluginSchema>

const endpoint = {
  server: NonEmptyString,
  port: PortSchema,
  udp: z.boolean().optional(),
  tfo: z.boolean().optional(),
}

/** "443"、"20000-30000"、"443,20000-30000" */
export const PortsSchema = z
  .string()
  .regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/)
  .refine(
    (s) =>
      s.split(',').every((part) => {
        const [a = Number.NaN, b = a] = part.split('-').map(Number)
        return a >= 1 && b <= 65535 && a <= b
      }),
    { message: 'invalid port range' },
  )

const Bandwidth = z.union([NonEmptyString, z.number().positive()]).transform(String)

export const SsProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('ss'),
  ...endpoint,
  cipher: NonEmptyString,
  password: NonEmptyString,
  plugin: SsPluginSchema.optional(),
  extra: ExtraSchema.optional(),
})

export const SsrProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('ssr'),
  ...endpoint,
  cipher: NonEmptyString,
  password: NonEmptyString,
  obfs: NonEmptyString,
  obfsParam: NonEmptyString.optional(),
  protocol: NonEmptyString,
  protocolParam: NonEmptyString.optional(),
  extra: ExtraSchema.optional(),
})

export const VmessProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('vmess'),
  ...endpoint,
  uuid: NonEmptyString,
  alterId: z.number().int().nonnegative(),
  cipher: NonEmptyString,
  tls: TlsOptionsSchema.optional(),
  transport: TransportSchema.optional(),
  extra: ExtraSchema.optional(),
})

export const VlessProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('vless'),
  ...endpoint,
  uuid: NonEmptyString,
  flow: NonEmptyString.optional(),
  tls: TlsOptionsSchema.optional(),
  transport: TransportSchema.optional(),
  extra: ExtraSchema.optional(),
})

export const TrojanProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('trojan'),
  ...endpoint,
  password: NonEmptyString,
  tls: TlsOptionsSchema,
  transport: TransportSchema.optional(),
  extra: ExtraSchema.optional(),
})

export const Hysteria2ProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('hysteria2'),
  ...endpoint,
  password: NonEmptyString.optional(),
  /** 端口跳跃，port 为其中第一个端口 */
  ports: PortsSchema.optional(),
  obfs: z.strictObject({ type: z.literal('salamander'), password: NonEmptyString }).optional(),
  up: Bandwidth.optional(),
  down: Bandwidth.optional(),
  tls: TlsOptionsSchema,
  extra: ExtraSchema.optional(),
})

export const TuicProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('tuic'),
  ...endpoint,
  uuid: NonEmptyString,
  password: NonEmptyString,
  congestionController: NonEmptyString.optional(),
  udpRelayMode: NonEmptyString.optional(),
  reduceRtt: z.boolean().optional(),
  tls: TlsOptionsSchema,
  extra: ExtraSchema.optional(),
})

export const WireguardProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('wireguard'),
  ...endpoint,
  privateKey: NonEmptyString,
  publicKey: NonEmptyString,
  preSharedKey: NonEmptyString.optional(),
  ip: NonEmptyString.optional(),
  ipv6: NonEmptyString.optional(),
  reserved: z.union([z.array(z.number().int().min(0).max(255)), NonEmptyString]).optional(),
  mtu: z.number().int().positive().optional(),
  extra: ExtraSchema.optional(),
})

export const AnytlsProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('anytls'),
  ...endpoint,
  password: NonEmptyString,
  tls: TlsOptionsSchema,
  extra: ExtraSchema.optional(),
})

export const HttpProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('http'),
  ...endpoint,
  username: NonEmptyString.optional(),
  password: NonEmptyString.optional(),
  tls: TlsOptionsSchema.optional(),
  extra: ExtraSchema.optional(),
})

export const Socks5ProxySchema = z.strictObject({
  name: NonEmptyString,
  type: z.literal('socks5'),
  ...endpoint,
  username: NonEmptyString.optional(),
  password: NonEmptyString.optional(),
  tls: TlsOptionsSchema.optional(),
  extra: ExtraSchema.optional(),
})

export const ProxySchema = z.discriminatedUnion('type', [
  SsProxySchema,
  SsrProxySchema,
  VmessProxySchema,
  VlessProxySchema,
  TrojanProxySchema,
  Hysteria2ProxySchema,
  TuicProxySchema,
  WireguardProxySchema,
  AnytlsProxySchema,
  HttpProxySchema,
  Socks5ProxySchema,
])
export type ProxyNode = z.infer<typeof ProxySchema>
export type ProxyOf<T extends ProxyType> = Extract<ProxyNode, { type: T }>
