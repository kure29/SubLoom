import { ExportOptionsSchema, exporters } from '@subloom/core'
import { z } from 'zod'
import { HttpError } from './errors.js'
import { MIN_TTL_SEC } from './sources/service.js'

// 请求体校验：各接口共用的字段与解析。校验失败统一返回 400 INVALID_REQUEST。

/** 本地订阅内容的上限与远程订阅响应体相同 */
export const MAX_CONTENT_CHARS = 10 * 1024 * 1024

export const nameSchema = z.string().trim().min(1).max(100)
export const urlSchema = z
  .string()
  .trim()
  .max(4096)
  .refine((s) => {
    try {
      const u = new URL(s)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }, 'must be an http or https URL')
export const userAgentSchema = z.string().trim().min(1).max(500).nullable()
export const ttlSecSchema = z
  .number()
  .int()
  .min(MIN_TTL_SEC)
  .max(30 * 86400)
export const contentSchema = z.string().min(1).max(MAX_CONTENT_CHARS)
export const idSchema = z.string().min(1).max(100)
export const timestampSchema = z.number().int().nonnegative()

/** 用户可设置的导出选项：proxyProvider 由 server 根据输出链接生成 */
export const UserExportOptionsSchema = ExportOptionsSchema.omit({ proxyProvider: true })

/** 输出选项（outputs.options_json），见 PLAN.md 5.3 */
export const OutputOptionsSchema = z.strictObject({
  export: UserExportOptionsSchema.optional(),
  /** 订阅节点内联（默认），或由 proxy-providers 引用 /sub/<token>/proxies（仅 mihomo） */
  nodes: z.enum(['inline', 'provider']).optional(),
})
export type OutputOptions = z.infer<typeof OutputOptionsSchema>

/** 输出的 target：已实现的导出器或 auto */
export const OutputTargetSchema = z
  .enum(['mihomo', 'surge', 'shadowrocket', 'loon', 'auto'])
  .refine((t) => t === 'auto' || Object.hasOwn(exporters, t), {
    error: (issue) => `the ${String(issue.input)} exporter is not implemented yet`,
  })
export type OutputTarget = z.infer<typeof OutputTargetSchema>

function invalid(error: z.ZodError): never {
  throw new HttpError(400, 'INVALID_REQUEST', z.prettifyError(error))
}

/** 解析 JSON 请求体并校验 */
export async function parseBody<T>(
  req: { json(): Promise<unknown> },
  schema: z.ZodType<T>,
): Promise<T> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', 'request body must be JSON')
  }
  const parsed = schema.safeParse(body)
  return parsed.success ? parsed.data : invalid(parsed.error)
}

/** 请求体可以为空（视为 {}） */
export async function parseOptionalBody<T>(
  req: { text(): Promise<string> },
  schema: z.ZodType<T>,
): Promise<T> {
  const text = await req.text()
  let body: unknown = {}
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      throw new HttpError(400, 'INVALID_REQUEST', 'request body must be JSON')
    }
  }
  const parsed = schema.safeParse(body)
  return parsed.success ? parsed.data : invalid(parsed.error)
}

/** 订阅源 id 列表：不重复 */
export const sourceIdsSchema = z
  .array(idSchema)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'source ids must be unique')
