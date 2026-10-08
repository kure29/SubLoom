/** 上游 `subscription-userinfo` 响应头中的流量（字节）与到期时间（Unix 秒） */
export interface Userinfo {
  upload?: number
  download?: number
  total?: number
  expire?: number
}

const FIELDS = ['upload', 'download', 'total', 'expire'] as const

/** 解析 `upload=…; download=…; total=…; expire=…`。没有任何可用字段时返回 null。 */
export function parseUserinfo(header: string | null | undefined): Userinfo | null {
  if (!header) return null
  const result: Userinfo = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const value = part.slice(eq + 1).trim()
    const field = FIELDS.find((f) => f === key)
    if (!field || !/^\d+$/.test(value)) continue
    const n = Number(value)
    if (Number.isSafeInteger(n)) result[field] = n
  }
  return Object.keys(result).length > 0 ? result : null
}
