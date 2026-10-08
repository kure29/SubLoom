import { assertFetchAllowed, type FetchPolicy, SsrfError } from './ssrf.js'
import { parseUserinfo, type Userinfo } from './userinfo.js'

// 订阅拉取。见 PLAN.md 5.4。错误信息中不包含 URL（可能带 token）。

/** 常见机场面板按 UA 中的 clash、meta 关键字返回 mihomo YAML */
export const DEFAULT_USER_AGENT = 'clash.meta'
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_MAX_REDIRECTS = 5

export class FetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchError'
  }
}

export interface FetchOptions extends FetchPolicy {
  userAgent: string
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

export interface FetchResult {
  text: string
  bytes: number
  userinfo: Userinfo | null
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** 拉取订阅：每一跳重定向都做 SSRF 检查；超时包括读取响应体；响应体超过上限即中断。 */
export async function fetchSubscription(url: string, opts: FetchOptions): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const signal = AbortSignal.timeout(timeoutMs)

  let current = url
  for (let hop = 0; ; hop++) {
    await assertFetchAllowed(current, opts)
    let res: Response
    try {
      res = await fetch(current, {
        headers: { 'user-agent': opts.userAgent, accept: '*/*' },
        redirect: 'manual',
        signal,
      })
    } catch (e) {
      throw requestError(e, signal, timeoutMs)
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      await res.body?.cancel()
      const location = res.headers.get('location')
      if (!location) throw new FetchError(`HTTP ${res.status} without Location header`)
      if (hop >= maxRedirects) throw new FetchError(`too many redirects (> ${maxRedirects})`)
      try {
        current = new URL(location, current).href
      } catch {
        throw new FetchError('invalid redirect location')
      }
      continue
    }

    if (!res.ok) {
      await res.body?.cancel()
      throw new FetchError(`HTTP ${res.status}`)
    }

    const length = Number(res.headers.get('content-length'))
    if (Number.isFinite(length) && length > maxBytes) {
      await res.body?.cancel()
      throw new FetchError(`response too large (> ${maxBytes} bytes)`)
    }

    const body = await readBody(res, maxBytes, signal, timeoutMs)
    return {
      text: new TextDecoder('utf-8').decode(body),
      bytes: body.length,
      userinfo: parseUserinfo(res.headers.get('subscription-userinfo')),
    }
  }
}

async function readBody(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  // mock 或部分实现的 fetch 不会因 signal 中断响应体读取，这里自己处理
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(requestError(signal.reason, signal, timeoutMs))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      total += value.length
      if (total > maxBytes) throw new FetchError(`response too large (> ${maxBytes} bytes)`)
      chunks.push(value)
    }
  } catch (e) {
    await reader.cancel().catch(() => {})
    throw e instanceof FetchError ? e : requestError(e, signal, timeoutMs)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    body.set(c, offset)
    offset += c.length
  }
  return body
}

function requestError(e: unknown, signal: AbortSignal, timeoutMs: number): Error {
  if (e instanceof FetchError || e instanceof SsrfError) return e
  if (signal.aborted) return new FetchError(`timed out after ${timeoutMs / 1000}s`)
  // 只保留错误类型和底层错误码（如 ECONNREFUSED），不带消息原文：其中可能包含 URL
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code
  const name = e instanceof Error ? e.name : 'Error'
  return new FetchError(`network error (${typeof code === 'string' ? code : name})`)
}
