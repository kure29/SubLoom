import type { PlatformEnv } from '@subloom/server'

export interface NodeConfig {
  port: number
  dataDir: string
  /** 定时刷新的检查间隔（分钟），0 为关闭 */
  refreshIntervalMin: number
  env: PlatformEnv
}

/** 读取环境变量，全部可选。见 PLAN.md 第 6 节。 */
export function readConfig(vars: Record<string, string | undefined>): NodeConfig {
  const str = (name: string) => {
    const v = vars[name]?.trim()
    return v ? v : undefined
  }
  const int = (name: string, fallback: number, min: number) => {
    const v = str(name)
    if (v === undefined) return fallback
    const n = Number(v)
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`)
    return n
  }
  return {
    port: int('PORT', 3000, 1),
    dataDir: str('DATA_DIR') ?? './data',
    refreshIntervalMin: int('REFRESH_INTERVAL_MIN', 10, 0),
    env: {
      adminToken: str('ADMIN_TOKEN'),
      secretKey: str('SECRET_KEY'),
      corsOrigins: (str('CORS_ORIGINS') ?? '')
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean),
      allowPrivateFetch: /^(?:1|true|yes)$/i.test(str('ALLOW_PRIVATE_FETCH') ?? ''),
    },
  }
}
