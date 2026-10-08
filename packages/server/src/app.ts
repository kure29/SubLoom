import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bootstrap } from './bootstrap.js'
import { sha256Hex, timingSafeEqual } from './crypto.js'
import { errorBody, HttpError } from './errors.js'
import type { Platform } from './platform.js'
import { sourceRoutes } from './sources/routes.js'
import type { Ctx } from './sources/service.js'

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

  app.route('/api/sources', sourceRoutes)
  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'not found'), 404))
  return app
}
