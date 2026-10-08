// Docker 入口：SQLite、文件 BlobStore、定时刷新。静态前端托管在 M6 中添加。
import { serve } from '@hono/node-server'
import { bootstrap, createApp, runScheduledRefresh } from '@subloom/server'
import { readConfig } from './env.js'
import { createNodePlatform } from './platform.js'

const config = readConfig(process.env)
const { platform, close } = await createNodePlatform(config.dataDir, config.env)
// 启动时先初始化（迁移、生成令牌），让自动生成的管理令牌出现在启动日志中
await bootstrap(platform)

const server = serve({ fetch: createApp(platform).fetch, port: config.port }, (info) => {
  console.log(`[subloom] listening on http://localhost:${info.port}`)
})

let timer: NodeJS.Timeout | undefined
if (config.refreshIntervalMin > 0) {
  let running = false
  const tick = async () => {
    if (running) return // 上一轮还没结束时跳过
    running = true
    try {
      await runScheduledRefresh(platform)
    } catch (e) {
      console.error('[subloom] scheduled refresh failed:', e)
    } finally {
      running = false
    }
  }
  timer = setInterval(tick, config.refreshIntervalMin * 60_000)
  void tick()
}

function shutdown() {
  clearInterval(timer)
  server.close(() => {
    close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
