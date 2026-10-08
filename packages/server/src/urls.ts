import type { PlatformEnv } from './platform.js'

// 对外链接（MANAGED-CONFIG 中的当前 URL、proxy-providers 的地址、输出的 url）。见 PLAN.md 5.3"对外链接"。

const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/

/**
 * 请求的对外 URL：设置了 PUBLIC_URL 时以它为准（不看请求头）；否则 TRUST_PROXY=true 时
 * 按 X-Forwarded-Proto / X-Forwarded-Host 改写；都未设置时用请求的 URL。
 */
export function externalUrl(
  requestUrl: string,
  header: (name: string) => string | undefined,
  env: Pick<PlatformEnv, 'publicUrl' | 'trustProxy'>,
): URL {
  const url = new URL(requestUrl)
  if (env.publicUrl) return new URL(`${env.publicUrl}${url.pathname}${url.search}`)
  if (env.trustProxy) {
    const first = (name: string) => header(name)?.split(',')[0]?.trim()
    const proto = first('x-forwarded-proto')?.toLowerCase()
    if (proto === 'http' || proto === 'https') url.protocol = `${proto}:`
    const host = first('x-forwarded-host')
    if (host && HOST.test(host)) url.host = host
  }
  return url
}

/** 设置了 PUBLIC_URL 时的完整链接，否则为 null */
export function publicLink(env: Pick<PlatformEnv, 'publicUrl'>, path: string): string | null {
  return env.publicUrl ? `${env.publicUrl}${path}` : null
}
