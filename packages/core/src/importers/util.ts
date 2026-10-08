import type { z } from 'zod'
import type { ExtraSource } from '../ir/index.js'
import type { ImportWarningCode } from './types.js'

/** 导入单个条目失败。message 只描述原因，不包含原始值。 */
export class ImportError extends Error {
  constructor(
    readonly code: ImportWarningCode,
    message: string,
  ) {
    super(message)
  }
}

export const invalid = (message: string) => new ImportError('INVALID_PROXY', message)

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 标准 / URL-safe Base64，可无 padding，允许夹杂空白。解码结果必须是合法 UTF-8。 */
export function decodeBase64(input: string): string | null {
  const s = input.replace(/\s+/g, '')
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null
  const body = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  if (body.length % 4 === 1) return null
  try {
    const bin = atob(body + '='.repeat((4 - (body.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function parsePort(raw: string | number | undefined, field = 'port'): number {
  const n =
    typeof raw === 'number' ? raw : raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw invalid(`"${field}" must be an integer between 1 and 65535`)
  }
  return n
}

/** 用于 name 回退：IPv6 加方括号 */
export const hostPort = (server: string, port: number) =>
  `${server.includes(':') ? `[${server}]` : server}:${port}`

/**
 * 读取来源对象并记录已消费的键，未消费的键（rest）进入 extra。
 * 空字符串、null 视为缺省。
 */
export class Reader {
  private readonly used = new Set<string>()

  constructor(
    readonly src: Record<string, unknown>,
    /** 用于错误信息的位置前缀，如 ws-opts */
    private readonly prefix = '',
  ) {}

  private label(key: string) {
    return `"${this.prefix ? `${this.prefix}.` : ''}${key}"`
  }

  peek(key: string): unknown {
    const v = this.src[key]
    return v === '' || v === null ? undefined : v
  }

  has(key: string): boolean {
    return this.peek(key) !== undefined
  }

  /** 标记为已消费但不读取（如无意义的默认值） */
  consume(...keys: string[]) {
    for (const k of keys) this.used.add(k)
  }

  raw(key: string): unknown {
    this.used.add(key)
    return this.peek(key)
  }

  str(key: string): string | undefined {
    const v = this.raw(key)
    if (v === undefined) return undefined
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    throw invalid(`${this.label(key)} must be a string`)
  }

  requiredStr(key: string): string {
    const v = this.str(key)
    if (v === undefined) throw invalid(`${this.label(key)} is required`)
    return v
  }

  int(key: string): number | undefined {
    const v = this.raw(key)
    if (v === undefined) return undefined
    const n =
      typeof v === 'number'
        ? v
        : typeof v === 'string' && /^-?\d+$/.test(v.trim())
          ? Number(v)
          : NaN
    if (!Number.isInteger(n)) throw invalid(`${this.label(key)} must be an integer`)
    return n
  }

  port(key: string): number {
    const v = this.raw(key)
    if (v === undefined) throw invalid(`${this.label(key)} is required`)
    return parsePort(typeof v === 'number' ? v : String(v).trim(), key)
  }

  bool(key: string): boolean | undefined {
    const v = this.raw(key)
    if (v === undefined) return undefined
    if (typeof v === 'boolean') return v
    const s = String(v).trim().toLowerCase()
    if (s === 'true' || s === '1') return true
    if (s === 'false' || s === '0') return false
    throw invalid(`${this.label(key)} must be a boolean`)
  }

  /** 列表：数组，或逗号分隔的字符串 */
  list(key: string): string[] | undefined {
    const v = this.raw(key)
    if (v === undefined) return undefined
    const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v]
    const out = items.map((x) => String(x).trim()).filter(Boolean)
    return out.length ? out : undefined
  }

  record(key: string): Record<string, unknown> | undefined {
    const v = this.raw(key)
    if (v === undefined) return undefined
    if (!isRecord(v)) throw invalid(`${this.label(key)} must be a mapping`)
    return v
  }

  /** 子对象读取器；其剩余字段由调用方通过 nest() 放回 */
  sub(key: string): Reader | undefined {
    const rec = this.record(key)
    return rec && new Reader(rec, this.prefix ? `${this.prefix}.${key}` : key)
  }

  /** 未消费的键，保持来源顺序 */
  rest(): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(this.src)) {
      if (this.used.has(k) || v === undefined || v === null || v === '') continue
      out[k] = v
    }
    return Object.keys(out).length ? out : undefined
  }
}

/** 将子读取器剩余的字段挂回父级剩余字段，如 { 'ws-opts': { ... } } */
export function nest(
  rest: Record<string, unknown> | undefined,
  key: string,
  child: Reader | undefined,
): Record<string, unknown> | undefined {
  const childRest = child?.rest()
  if (!childRest) return rest
  return { ...rest, [key]: childRest }
}

export function extraOf(source: ExtraSource, rest: Record<string, unknown> | undefined) {
  return rest && Object.keys(rest).length ? { [source]: rest } : undefined
}

/**
 * 规范形式：去掉值为 undefined 或 false 的字段（extra 内部原样保留）。
 * 默认值为 false 的可选布尔字段因此统一省略。
 */
export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T
  if (!isRecordLike(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === false) continue
    out[k] = k === 'extra' ? v : canonical(v)
  }
  return out as T
}

function isRecordLike(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && Object.getPrototypeOf(v) === Object.prototype
}

/** zod 校验失败时生成不含原始值的说明 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}
