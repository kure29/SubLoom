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

/**
 * 合并多个来源的流量信息（`/sub/:token` 的 subscription-userinfo）。见 PLAN.md 5.3"流量信息合并"。
 * 没有流量信息的来源（null）不参与；upload、download、total 对给出了该字段的来源求和；
 * expire 取给出了该字段的来源中最早的一个，expire=0（不过期）视为未给出。都没有时返回 null。
 */
export function mergeUserinfo(list: ReadonlyArray<Userinfo | null>): Userinfo | null {
  const result: Userinfo = {}
  let any = false
  for (const info of list) {
    if (!info) continue
    any = true
    for (const field of ['upload', 'download', 'total'] as const) {
      const v = info[field]
      if (v !== undefined) result[field] = (result[field] ?? 0) + v
    }
    if (info.expire) result.expire = Math.min(result.expire ?? info.expire, info.expire)
  }
  return any ? result : null
}

/** 按 upload、download、total、expire 的顺序格式化，省略缺失的字段 */
export function formatUserinfo(info: Userinfo): string {
  return FIELDS.filter((f) => info[f] !== undefined)
    .map((f) => `${f}=${info[f]}`)
    .join('; ')
}
