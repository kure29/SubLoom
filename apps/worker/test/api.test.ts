import { bootstrap, createApp, runScheduledRefresh } from '@subloom/server'
import { beforeEach } from 'vitest'
import { describeApi } from '../../../packages/server/test/api/suite.js'
import { createKvBlobStore } from '../src/blob-store.js'
import { createDb } from '../src/platform.js'
import { nextBindings, resetStorage } from './storage.js'

// 在 Workers（workerd + miniflare 的 D1、KV）下运行与运行时无关的 API 集成测试
beforeEach(resetStorage)

describeApi({ bootstrap, createApp, runScheduledRefresh }, async () => {
  const { d1, kv } = nextBindings()
  return {
    name: 'workers',
    db: createDb(d1),
    blobs: createKvBlobStore(kv),
    waitUntil: (p) => void p.catch((e: unknown) => console.error('background task failed:', e)),
  }
})
