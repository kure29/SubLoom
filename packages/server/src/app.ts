import { settings } from '@subloom/db'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { backupRoutes } from './backup.js'
import { bootstrap } from './bootstrap.js'
import { sha256Hex, timingSafeEqual } from './crypto.js'
import { errorBody, HttpError } from './errors.js'
import { metaRoutes } from './meta.js'
import { outputRoutes } from './outputs/routes.js'
import type { Platform } from './platform.js'
import { profileRoutes } from './profiles/routes.js'
import { sourceRoutes } from './sources/routes.js'
import type { Ctx } from './sources/service.js'
import { subRoutes } from './sub/routes.js'

export interface AppEnv {
  Variables: { ctx: Ctx }
}

/** Hono 应用工厂，与运行时无关。见 PLAN.md 5.1、5.3。 */
export function createApp(platform: Platform) {
  const app = new Hono<AppEnv>()

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(err.code, err.message), err.status)
    console.error('[subloom] unhandled error:', err)
    return c.json(errorBody('INTERNAL', 'internal error'), 500)
  })

  // 管理接口：CORS → 初始化 → 认证
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (platform.env.corsOrigins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['authorization', 'content-type'],
      maxAge: 86400,
    }),
  )
  app.use('/api/*', async (c, next) => {
    const runtime = await bootstrap(platform)
    const auth = c.req.header('authorization') ?? ''
    const match = /^Bearer\s+(\S+)$/i.exec(auth)
    // 对请求中的令牌取哈希后与期望的哈希做常量时间比较
    if (!match?.[1] || !timingSafeEqual(await sha256Hex(match[1]), runtime.adminTokenHash)) {
      throw new HttpError(401, 'UNAUTHORIZED', 'missing or invalid admin token')
    }
    c.set('ctx', { platform, runtime })
    await next()
  })

  app.route('/api/meta', metaRoutes)
  app.route('/api/sources', sourceRoutes)
  app.route('/api/profiles', profileRoutes)
  app.route('/api/outputs', outputRoutes)
  app.route('/api', backupRoutes)

  // 公开接口：靠 token 访问，不需要管理令牌
  app.use('/sub/*', async (c, next) => {
    c.set('ctx', { platform, runtime: await bootstrap(platform) })
    await next()
  })
  app.route('/sub', subRoutes)

  // 健康检查：初始化（迁移）和数据库访问都正常时返回 ok；失败时不返回细节
  app.get('/healthz', async (c) => {
    try {
      await bootstrap(platform)
      await platform.db.select().from(settings).limit(1)
      return c.json({ status: 'ok' })
    } catch (e) {
      console.error('[subloom] health check failed:', e instanceof Error ? e.message : String(e))
      return c.json({ status: 'error' }, 503)
    }
  })

  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'not found'), 404))
  return app
}
