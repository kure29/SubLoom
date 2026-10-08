// Workers 入口：D1、KV BlobStore、Cron Triggers。静态前端由 Workers Static Assets 直接托管，
// 只有 /api/*、/sub/*、/healthz 交给这里（见仓库根目录的 wrangler.jsonc 与 PLAN.md 第 6 节）。
import { createApp, runScheduledRefresh } from '@subloom/server'
import { createPlatform, type Env } from './platform.js'

export type { Env } from './platform.js'

function configError(e: unknown): Response {
  // 原因写在日志中（可能含配置的值），响应中不返回
  console.error('[subloom] invalid configuration:', e instanceof Error ? e.message : String(e))
  return Response.json(
    { error: { code: 'INTERNAL', message: 'invalid server configuration, see the Worker logs' } },
    { status: 500 },
  )
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let platform: ReturnType<typeof createPlatform>
    try {
      platform = createPlatform(env, ctx)
    } catch (e) {
      return configError(e)
    }
    return createApp(platform).fetch(request, env, ctx)
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const platform = createPlatform(env, ctx)
    ctx.waitUntil(
      runScheduledRefresh(platform).catch((e: unknown) =>
        console.error('[subloom] scheduled refresh failed:', e),
      ),
    )
  },
} satisfies ExportedHandler<Env>
