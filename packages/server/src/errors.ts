import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'NO_CACHE'
  | 'INTERNAL'
  | SourceErrorCode

/** 刷新订阅失败的原因，见 PLAN.md 5.3 */
export type SourceErrorCode = 'SSRF_BLOCKED' | 'FETCH_FAILED' | 'PARSE_FAILED' | 'DECRYPT_FAILED'

/** 由 app.onError 转为 `{ error: { code, message } }` */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const errorBody = (code: ErrorCode, message: string) => ({ error: { code, message } })
