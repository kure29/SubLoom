import type { PlatformEnv } from './platform.js'

// 环境变量解析：Node（process.env）和 Workers（env 中的 vars、secrets）共用。见 PLAN.md 5.1。

const TRUE = /^(?:1|true|yes)$/i

/** PUBLIC_URL：不带查询参数、片段和用户信息的 http(s) URL，去掉末尾的 / */
function parsePublicUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('PUBLIC_URL must be an absolute http(s) URL, e.g. https://sub.example.com')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'PUBLIC_URL must be an http(s) URL without query, fragment or credentials, e.g. https://sub.example.com',
    )
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * 把字符串形式的环境变量解析为 PlatformEnv。非字符串的值（Workers 的 D1、KV 等绑定）忽略，
 * 空字符串视为未设置，布尔值只有 true、1、yes（不区分大小写）为真。不合法时抛出错误。
 */
export function parseEnv(vars: Readonly<Record<string, unknown>>): PlatformEnv {
  const str = (name: string) => {
    const v = vars[name]
    if (typeof v !== 'string') return undefined
    const trimmed = v.trim()
    return trimmed ? trimmed : undefined
  }
  const bool = (name: string) => TRUE.test(str(name) ?? '')
  const publicUrl = str('PUBLIC_URL')
  return {
    adminToken: str('ADMIN_TOKEN'),
    secretKey: str('SECRET_KEY'),
    corsOrigins: (str('CORS_ORIGINS') ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    allowPrivateFetch: bool('ALLOW_PRIVATE_FETCH'),
    publicUrl: publicUrl === undefined ? undefined : parsePublicUrl(publicUrl),
    trustProxy: bool('TRUST_PROXY'),
  }
}
