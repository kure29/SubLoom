import { sources } from '@subloom/db'
import { eq } from 'drizzle-orm'
import { bootstrap } from './bootstrap.js'
import type { Platform } from './platform.js'
import { refreshSource } from './sources/service.js'

/**
 * 定时刷新：逐个刷新到期的远程订阅（last_fetched_at + ttl_sec 已过，或从未拉取过），串行执行。
 * Node 用 setInterval 调用，Workers 在 scheduled 事件中调用。见 PLAN.md 5.1。
 */
export async function runScheduledRefresh(
  platform: Platform,
): Promise<{ refreshed: number; failed: number }> {
  const runtime = await bootstrap(platform)
  const ctx = { platform, runtime }
  const rows = await platform.db.select().from(sources).where(eq(sources.kind, 'remote'))
  let refreshed = 0
  let failed = 0
  for (const row of rows) {
    const now = Date.now()
    if (row.lastFetchedAt !== null && row.lastFetchedAt + row.ttlSec * 1000 > now) continue
    try {
      const result = await refreshSource(ctx, row)
      if (result.ok) refreshed++
      else failed++
    } catch (e) {
      // 意外错误（如存储写入失败）不影响其他订阅
      failed++
      console.error(`[subloom] refresh source ${row.id} failed unexpectedly:`, e)
    }
  }
  if (refreshed + failed > 0) {
    console.info(`[subloom] scheduled refresh: ${refreshed} refreshed, ${failed} failed`)
  }
  return { refreshed, failed }
}
