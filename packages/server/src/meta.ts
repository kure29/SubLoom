import { type Capabilities, CORE_VERSION, exporters } from '@subloom/core'
import { Hono } from 'hono'
import type { AppEnv } from './app.js'
import type { Runtime } from './bootstrap.js'
import type { Platform } from './platform.js'
import { VERSION } from './version.js'

/** GET /api/meta。见 PLAN.md 5.3。 */
export interface MetaDto {
  name: 'subloom'
  version: string
  coreVersion: string
  platform: Platform['name']
  /** generated 时前端提示用户设置 SECRET_KEY（见 PLAN.md 5.5"密钥来源"） */
  secretKeySource: Runtime['secretKeySource']
  /** 已实现的导出器及其能力矩阵 */
  targets: Partial<Record<string, Capabilities>>
}

export const metaRoutes = new Hono<AppEnv>().get('/', (c) => {
  const { platform, runtime } = c.get('ctx')
  const meta: MetaDto = {
    name: 'subloom',
    version: VERSION,
    coreVersion: CORE_VERSION,
    platform: platform.name,
    secretKeySource: runtime.secretKeySource,
    targets: Object.fromEntries(
      Object.entries(exporters).map(([target, e]) => [target, e.capabilities]),
    ),
  }
  return c.json(meta)
})
